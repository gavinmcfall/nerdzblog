---
title: "Three 990 PROs, One Batch, All Dying — Part 1: The Slow Death"
description: "What happens when you put consumer NVMe under an etcd + Ceph mon workload. Part 1 of 3."
date: 2026-05-05
slug: "2026/three-990-pros-all-dying-part-1"
toc: true
math: false
draft: false
featured: true
Tags:
  - NVMe
  - SSD
  - Hardware
  - Talos
  - etcd
  - Ceph
  - Kubernetes
  - Homelab
Categories: [Hardware, Homelab]
---

> "PASSED" doesn't mean what you think it means.

## The 2am alert storm

My phone exploded with critical alerts overnight. ntfy was angry. Alertmanager was angry. Ceph was angry. Sonarr was rolling back to a state that didn't exist. Prometheus had even disconnected itself from Alertmanager — the canary alert that fires when alerting itself is broken.

The root cause was buried under several cascading consequences, but the actual finding was simple: the NVMe holding `/var` on stanton-02 had stopped responding to interrupts. The kernel logged `Disabling IRQ #173` and gave up. Ceph's `osd.1` went `down`, `mon.b` lost its RocksDB, and the whole cluster started swimming.

Over the next several hours of recovery, I confirmed that this wasn't a one-off. It was the latest event in a documented escalation that had been building for weeks. The Samsung 990 PRO 1TB on stanton-02 had been throwing controller-fatal-status events since mid-April — six events over 19 days, each interval shorter than the last, until the kernel finally gave up on the IRQ and walked away.

But that's not the interesting bit. The interesting bit is that the drive's two siblings — same batch, same firmware, same workload, in the same cluster — are also dying. Just at different rates.

This is part 1 of 2. Part 1 is the autopsy. Part 2 will come when the new drives arrive.

## The cluster

Three [Minisforum MS-01](https://store.minisforum.com/products/minisforum-ms-01) mini-PCs, each running Talos Linux as a Kubernetes control-plane node. Cluster name: stanton _(cf. [Star Citizen](https://robertsspaceindustries.com/))_. Each box has two NVMe drives:

- **nvme0** — Samsung PM9A3 1.92TB. Enterprise-class with PLP. Rook-Ceph OSD storage. Rock solid.
- **nvme1** — Samsung 990 PRO 1TB. **Consumer**. Holds `/var`: etcd WAL, Ceph mon RocksDB, container logs, kubelet state.

You can probably already see where this is going.

I bought the three 990 PROs as a matched batch from Amazon AU's Global Store on 2024-06-18. Same firmware revision (`4B2QJXD7` — the one Samsung released after the [990 PRO firmware-killing-itself bug](https://www.tomshardware.com/news/samsung-issues-firmware-update-for-990-pro-ssds), so we're not even talking about THAT problem). They went into production almost immediately and have been running 24/7 for ~22 months.

The workload on `/var`:

- **etcd WAL** — Every Kubernetes API write. Pod scheduling, controller reconciliation, kubelet leases. Constant fsync.
- **Ceph mon RocksDB** — Cluster state churn. Constant tiny writes.
- **Container runtime overlay** — Image extraction, log writes, layer state.

Fsync-heavy. Small-block-write heavy. The exact opposite of what consumer SSDs are tuned for.

## The autopsy

After getting the cluster back to HEALTH_OK, I pulled SMART data off all three nvme1 drives. Same command on each:

```bash
kubectl debug node/stanton-XX --image=alpine --profile=sysadmin -- \
  sh -c "apk add -q smartmontools && smartctl -a /dev/nvme1"
```

Here's the comparison:

| Metric | stanton-01 | stanton-02 (failed) | stanton-03 |
|---|---|---|---|
| Serial | S73VNU0X303066H | S73VNU0X303413H | S73VNU0X303400H |
| Firmware | `4B2QJXD7` | `4B2QJXD7` | `4B2QJXD7` |
| Power-On Hours | 15,856 | 15,864 | 15,867 |
| **Percentage Used** | **42%** | **47%** | **50%** |
| **Data Units Written** | **96.3 TB** | **112 TB** | **133 TB** |
| Power Cycles | 83 | 35 | 38 |
| **Unsafe Shutdowns** | **37 (45% of cycles)** | **15 (43% of cycles)** | **13 (34% of cycles)** |
| Critical Warning | `0x00` | `0x00` | `0x00` |
| Media & Data Integrity Errors | 0 | 0 | 0 |
| Available Spare | 100% | 100% | 100% |
| **SMART Self-Test** | **PASSED** | **PASSED** | **PASSED** |
| Temperature | 54°C | 53°C | 53°C |

Three things should jump out.

**First**, all three drives "PASSED" the self-test. The drive that just died with a kernel-level IRQ-disable failure says it's healthy. So does the one with 50% wear. So does the one I haven't even seen flap yet.

**Second**, stanton-03 has more wear (50%) than the drive that just died (47%). It's next in line.

**Third**, the wear math doesn't add up. The 990 PRO 1TB has a 600 TBW endurance rating. stanton-03 has written 133 TB — 22% of its rated endurance — but reports 50% used. The drives are wearing **roughly twice as fast as host writes alone would suggest.**

That last one is the actually interesting story.

## Why is the wear accelerating?

`Percentage Used` in NVMe SMART data isn't a measurement of how many host writes you've done. It's the drive's own estimate of how much of its **internal NAND endurance reserve** has been consumed.

For consumer drives, the gap between "host writes" and "NAND wear" gets large when you have:

1. **Small random writes** — etcd does fsync after every write. The drive can't batch these, so it ends up writing-in then re-writing pages constantly to maintain durability semantics.
2. **No power-loss protection** — every unclean shutdown forces the drive to discard in-flight write buffers and rebuild from journal, which means re-writing pages the drive thought it could batch. Wear amplification.
3. **Mixed read/write pages** — when read traffic and write traffic share NAND blocks, the drive shuffles data around to keep cells in spec. All extra writes the host never asked for.

Each of those happens constantly under an etcd + mon workload.

The unsafe-shutdown counter is the nail in the coffin. Across the three drives:

- stanton-01: **37 unsafe shutdowns out of 83 cycles** (45%)
- stanton-02: **15 unsafe shutdowns out of 35 cycles** (43%)
- stanton-03: **13 unsafe shutdowns out of 38 cycles** (34%)

I don't have a UPS. The cluster has weathered multiple powercuts since I built it, plus the occasional kernel-level reboot under stress. Every one of those is a little bit of write-amp punishment to a drive that has no capacitors to flush its DRAM cache to NAND.

## Power Loss Protection — what consumer NVMe doesn't have

Enterprise NVMe drives have a row of tantalum capacitors on the PCB. When the host yanks power, those caps hold the drive alive just long enough to flush its DRAM write buffer to flash. Result: no data loss, no in-flight pages stuck in limbo, no journal-replay amp on the next boot.

Consumer NVMe drives do not have those capacitors. Cost-cut. The 990 PRO is a consumer drive. So is the SN850X. So is anything you'd buy at a big-box store with "Pro" in the name.

When a consumer drive loses power mid-write:

- In-flight writes that were in DRAM are gone. The host's write-cache thinks they hit NAND, but they didn't.
- On next boot, the drive replays its journal to figure out which pages are valid and which are torn.
- That replay re-writes a lot of pages "to be safe."
- All of which counts against your NAND endurance reserve.

This is why enterprise SSD specs say things like "0.4 DWPD" or "1 DWPD" or "3 DWPD" — Drive Writes Per Day, sustained for the warranty period (usually 5 years). The 990 PRO's spec is `600 TBW over 5 years`, which works out to about 0.33 DWPD if you do the math. **That assumes a clean workload with no powercut amplification.**

What I have is consumer drives, with no PLP, doing fsync-heavy etcd workloads, on hosts with no UPS, in a region that has the occasional powercut. Of course the wear is accelerating.

## What SMART didn't tell me

The most maddening thing about this whole episode is that the drive's "PASSED" self-test was technically correct, right up until it wasn't.

NVMe SMART tracks things like media errors, temperature exceedences, and the available-spare counter. None of those tripped. The drive on stanton-02 is still reporting 100% Available Spare and 0 Media Errors as of writing. It also happens to be unable to respond to interrupts anymore.

The actual signal of impending failure was buried in the kernel log — six controller-fatal-status events over 19 days, with the gap between events shrinking each time:

```
nvme nvme1: controller is down; will reset: CSTS=0x3, PCI_STATUS=0x11
```

`CSTS=0x3` means the drive's own controller is asserting **fatal status** on itself. That's the drive saying "something is wrong with me, please reset me." The kernel resets it, the drive comes back up, and SMART still says PASSED because by the spec, none of the threshold-based metrics have been crossed.

The escalation timeline:

| # | Date (UTC) | Failure mode |
|---|---|---|
| 1 | 2026-04-15 | Soft CFS reset, auto-recovered |
| 2 | 2026-04-20 | Soft CFS reset, auto-recovered |
| 3 | 2026-04-21 | Soft CFS reset, auto-recovered |
| 4 | 2026-04-25 | Soft CFS reset, auto-recovered |
| 5 | 2026-04-30 | Soft CFS reset, auto-recovered |
| 6 | 2026-05-04 | **IRQ disabled, no auto-recovery** |

The pattern is "drive needs increasingly frequent kicks until eventually the kernel gives up on it." None of which shows up in `smartctl --health`.

## Side effects when the cluster_network is on the same node

Here's the bit that turned an annoying-but-recoverable single-drive failure into a 4-hour cluster-wide incident: stanton-02 also runs one of three Ceph monitors AND one of three OSDs. The 990 PRO holds `/var` (mon RocksDB), and the PM9A3 in nvme0 holds the OSD bluestore data. When the 990 PRO died, mon.b went silent, but the OSD itself was still up.

Then I rebooted the node to get the drive back. The reboot killed the Thunderbolt ring that Ceph uses for `cluster_network` traffic — a documented MS-01 quirk where the second TB port doesn't always re-enumerate after a warm boot. So when the node came back, OSDs were `up,in` per Ceph, but `osd.1` and `osd.2` couldn't actually talk to each other over the cluster network. PGs got stuck `peering` for an hour while traffic spilled to `public_network` and the slow-heartbeat alarms climbed past 500 seconds.

I wrote up the Thunderbolt fix separately — kernel arg `thunderbolt.host_reset=0` baked into a custom factory.talos.dev schematic — but it's worth mentioning here because it's the failure-mode amplifier. **A single dying disk wouldn't have caused a cluster-wide alert storm if my Ceph cluster network wasn't running over Thunderbolt cables that don't always come back up after a reboot.** Two unrelated weaknesses combined into one bad night.

## What I'm doing about it

After confirming the failure was real and ongoing, I went back to Amazon AU. The drive had 38 months left on a 5-year warranty, the failure mode is documented in dmesg with timestamps and serial numbers, and the SMART screenshots showed the wear/unsafe-shutdown picture clearly. Amazon's Global Store rep was sympathetic.

To my surprise, they refunded the **full cost of all three drives** — not just the failing one. Recognition that a same-batch matched set is going to fail in similar ways was a nicer outcome than I expected.

Now I'm shopping for replacements. The path:

- **Enterprise NVMe with hardware PLP** — non-negotiable. The whole point is to remove the consumer-NAND-on-server-workload mismatch.
- **M.2 22110 form factor** — fits the MS-01's slot 2 and 3. The PM9A3 already in nvme0 has been rock solid; putting its sibling family in nvme1 keeps the cluster homogeneous.
- **At least 1 DWPD endurance class** — overkill for my measured 180 GB/day write rate (~0.18 DWPD on a 1TB drive), but every doubling of headroom is insurance against future workload growth.

The shortlist I've narrowed it to is **Samsung PM9A3 M.2 22110 960GB** (NEW from a Chinese eBay seller at ~AU$554 each) or **Micron 7450 PRO 480GB** (new retail, but the NZ pricing is eye-watering). The math + budget pushed me toward the PM9A3 — it matches the drive that's been working flawlessly on the same cluster for 22 months.

That's where Part 2 comes in. New drives, installation, performance comparison, the burn-in protocol, and the real test: whether enterprise PLP actually fixes the failure mode I've documented here, or whether the MS-01's chassis is going to throw new and unexpected thermal headaches at me with 8.2W enterprise drives in slots designed for 5W consumer parts.

## Lessons so far

- **"PASSED" SMART status is necessary but not sufficient.** Watch the kernel log for `CSTS=0x3` and similar; SMART's threshold-based metrics will lag behind the actual drive health by months.
- **Consumer NVMe under etcd workload is a category error.** Even on a homelab, if the drive holds `/var` for a Kubernetes control-plane, it's doing enterprise work. Buy enterprise.
- **The `Percentage Used` metric tells you the truth.** When it's growing roughly 2× faster than `Data Units Written ÷ TBW` would predict, your drive is wearing out faster than spec, and you need to plan for replacement before the controller events start.
- **PLP is the structural fix.** A UPS helps with powercuts but doesn't fix the fsync-amp problem on consumer NAND.
- **Same-batch drives die together.** If one drive in a matched set fails, pull SMART on all of them. They'll be on the same trajectory. In my case, the most-worn drive isn't the one that failed first — it's the one I haven't seen flap yet.
- **Architectural single-points-of-pain compound.** A drive failure on its own is recoverable. A drive failure plus a fragile cluster_network on the same node is a bad night. Audit your dependencies before you have to.

Part 2 incoming when the new drives arrive. Until then I'm running on borrowed time on stanton-03 (the 50%-wear sibling). Coffee in hand, alert thresholds tightened, Renovate auto-merge disabled on Ceph until the swap is done.
