---
title: "Three 990 PROs, One Batch, All Dying — Part 2: The Replacement"
description: "Enterprise SSDs arrived, so I migrated a live Talos control plane onto them. First I had to fix the backups, then learn that swapping a boot disk on Talos isn't a swap at all — it's a rebuild. Plus the canary node that taught me five things I only half-believed."
date: 2026-05-26
slug: "2026/three-990-pros-all-dying-part-2"
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
  - Rook
  - CloudNativePG
  - pgBackRest
  - Kubernetes
  - Homelab
Categories: [Hardware, Homelab]
---

> You don't perform open-heart surgery until you're sure the blood bank works.

In [Part 1](/2026/three-990-pros-all-dying-part-1) I did the autopsy: three consumer Samsung 990 PROs, same batch, holding `/var` for my Talos control plane, all wearing out roughly twice as fast as host writes alone would explain — one already dead with a kernel-level IRQ-disable, the other two queued up behind it. Amazon refunded the whole batch, and I bought three **Samsung PM9A3 960GB** enterprise drives to replace them — power-loss protection, proper endurance, the same family as the OSD drives that have run flawlessly for 22 months.

I called it "Part 1 of 2." This is Part 2. Reader, it turned into Part 3 as well, because the cluster had opinions. This part is the prep and the canary; [Part 3](/2026/three-990-pros-all-dying-part-3) is the other two nodes and everything that went sideways.

## Step one wasn't the disk swap

I sat down to plan the swap and immediately tripped over a rule I keep relearning: swapping the OS disk on a control-plane node is a **rebuild** — etcd member, Ceph mon, the lot. If anything goes sideways mid-rebuild, my recovery path is the backups. So before touching a disk, I went to check the backups.

They were broken. Quietly, in three different ways.

This is the CloudNativePG / pgBackRest setup behind my Postgres clusters. What I found:

| What I found | Reality |
|---|---|
| The "daily" backup | Running **hourly** — a five-field cron (`0 3 * * *`) silently parsed as six-field (seconds-first), so it meant "every hour at :03" |
| Backup chain depth | **1 full from December + 1,573 incrementals** stacked on it. Never re-based. |
| Accumulated `Backup` objects | **7,537** of them in the namespace — months of ~48/day, over half failed |
| Forcing a fresh full | The plugin silently ignored `type: full`; the correct key was `backupType: full` |

That cron one is worth dwelling on, because it's a trap anyone using CloudNativePG can fall into: **`ScheduledBackup.spec.schedule` is a six-field cron** — the first field is *seconds*. A normal five-field expression doesn't error, it just shifts. `0 3 * * *`, which I read as "3am daily," became `sec=0 min=3 hour=*` — the top of every hour. That single misparse generated the 7,537 objects.

Fixes shipped:

- `backupType: full` weekly + explicit `backupType: incr` daily, both on proper **six-field** crons (`0 0 3 * * *`, `0 0 1 * * 0`)
- Cleaned 7,537 → 339 `Backup` objects (no finalizers, so the B2 data was never at risk)
- Took a fresh full to Backblaze **and** an independent `pg_dumpall` to the NAS as a break-glass copy

Then the part that actually matters: I **proved the restore**. Recovered the logical dump into a throwaway cluster and confirmed all 42 roles and 50 databases came back, data intact, with the production B2 repo untouched. *A backup you haven't restored is a rumour.*

Only then did I let myself near the disks.

## Burn-in

The PM9A3s arrived described as "recertified," which made me suspicious, but SMART said otherwise — **zero power-on hours, zero writes, pristine**. I burned them in anyway before trusting them with etcd: two hours of `fio` per drive, full-tilt 4k random write then a 70/30 read/write mix.

| Drive | randwrite | IOPS | Media errors | Note |
|---|---|---|---|---|
| stanton-01 (`S5XMNE0TC58615`) | 731 MiB/s | 187k | 0 | sensor 2 brushed 78°C |
| stanton-02 (`S5XMNE2TC24056`) | 735 MiB/s | 188k | 0 | passive-cooled MS-01 slot |
| stanton-03 (`S5XMNE1TC99141`) | 732 MiB/s | 187k | 0 | within 0.2% of the others |

All three within 0.2% of each other. That tight a spread is what healthy, identical-firmware drives look like — the opposite of the diverging-wear picture from Part 1. They do run hotter than the 990s (8.25W idle vs ~5W), so the chassis sits warmer after the swap. Worth watching, not worth worrying about: 78°C under a torture test, 85°C is the throttle line.

## Then Talos made me read the manual

My first plan was naive: change `installDiskSelector` to the PM9A3's serial, `apply-config --reboot`, done.

Wrong. `installDiskSelector` is consumed by the **installer** — initial install and `talosctl upgrade` — not by a running node. Change the config and reboot a healthy node and it just boots the existing install on the old 990. As a Sidero maintainer put it in a discussion thread: *"Existing installations must be wiped before attempting migration."*

So moving the OS to the PM9A3 is a genuine **per-node rebuild**: drain the node, remove its etcd member, power off, physically pull the 990, boot the PM9A3 fresh from a Talos USB in maintenance mode, let it reinstall and rejoin. etcd drops to 2/3 and recovers. The Ceph mon rebuilds. And the Ceph OSD on the *other* disk — the PM9A3 that was already in nvme0 — has to be re-adopted, because Rook's local metadata lives on the `/var` I'm about to wipe.

That last bit was the real unknown, and it's why I didn't do all three at once.

## The canary: stanton-02

stanton-02 had the flakiest 990 (the one that actually died in Part 1), so it was both the most urgent node and the one I'd least mind learning on. I wrote the runbook with the five things I genuinely didn't know would work until I did one, because pretending I knew would just hide where the risk was:

1. the exact `etcd remove-member` syntax
2. the maintenance-mode IP
3. whether `apply-config --insecure` actually installs to the new disk
4. **whether Rook re-adopts the OSD or rebuilds it** (the one that mattered)
5. how long the Ceph mon takes to rebuild

### Drain, then freeze Ceph

Cordon, drain. The expected things went `Pending` — the Ceph mon and OSD (pinned to the node) and the CNPG replicas (anti-affinity won't co-locate them). Then, before powering off, the step the first draft of my runbook *didn't* have and should have: **freeze Ceph.** An OSD that's been down for 10 minutes gets marked `out`, and Ceph starts re-replicating its data elsewhere — pointless churn when the node's coming right back.

```
ceph osd set noout
ceph osd set norebalance
```

`2 up, 3 in` — `osd.1` down but still counted, no rebalance. Now I could take as long as I needed.

### The etcd dance

```
$ talosctl --nodes 10.90.3.101 etcd remove-member stanton-02
error parsing etcd member id: strconv.ParseUint: parsing "stanton-02": invalid syntax
```

It wants the **member ID, not the hostname**. `talosctl etcd members` shows it in hex; feed that in, and we're down to two members, both healthy, quorum intact. Unknown #1: solved.

### Pull, boot, install

Pulled the 990, left the OSD disk and the PM9A3 in, inserted the USB, F11, maintenance mode. Because I run MAC-reservation DHCP, the node came up on its usual `10.90.3.102` — no hunting for a maintenance IP. Unknown #2: solved.

Checked the disks before installing, because paranoia is healthy when you're about to wipe something:

```
/dev/nvme1n1  SAMSUNG MZ1L2960HCJR-00AMV  S5XMNE2TC24056   960 GB   ← PM9A3
/dev/nvme0n1  SAMSUNG MZQL21T9HCJR-00A07  S64GNN0WB06544   1.9 TB   ← Ceph OSD
```

990 gone, PM9A3 present, not yet a system disk. Apply the config:

```
talosctl apply-config --insecure --nodes 10.90.3.102 \
  --file clusterconfig/home-kubernetes-stanton-02.yaml
```

Watched the install run on the JetKVM, pulled the USB at the reboot. Unknown #3: it installs to the configured disk. Solved.

### The moment I didn't like

Node back, etcd rejoined, all three in sync. Then I checked the system disk:

```
SystemDisk  system-disk  →  nvme0n1
```

`nvme0n1`. That was the **Ceph OSD disk** in maintenance mode. Did I just install Talos over an OSD?

Short answer: no — and this is exactly why you pin by serial, not by `/dev/nvmeX`. When the 990 left, the two remaining drives **re-enumerated** — the PM9A3 moved from `nvme1n1` to `nvme0n1`. `installDiskSelector.serial` followed the *drive*, not the name:

```
/dev/nvme0n1  SAMSUNG MZ1L2960HCJR-00AMV  S5XMNE2TC24056   ← PM9A3, the system disk
/dev/nvme1n1  SAMSUNG MZQL21T9HCJR-00A07  S64GNN0WB06544   ← Ceph OSD, untouched
```

The thing that looked like a disaster was the safety mechanism working. **Always verify the system disk's serial, never trust the device name.** (This bites again in Part 3, harder.)

### The one that mattered: the OSD

`osd.1`'s data lives on the OSD drive, which I never touched. The question was whether Rook would *re-adopt* that OSD or treat the disk as new and rebuild it — a full backfill from the other two nodes. I uncordoned and watched:

```
rook-ceph-osd-1-...  Init:0/4  stanton-02
```

No `osd-prepare` job spawned. That's the tell — Rook didn't run a prepare/zap pass, it just started the existing OSD deployment. A minute later:

```
mon: 3 daemons, quorum a,b,c
osd: 3 osds: 3 up, 3 in
pgs: 169 active+clean
osd.1  up  1.00000   ← same ID, weight intact
```

**Re-adopted.** Same OSD ID, data intact, `169 active+clean` — and because of `noout`, zero data movement. Unknowns #4 and #5: solved, the good way. Unset the flags, `HEALTH_OK`.

## What the canary cost

| | |
|---|---|
| Ceph data rebalanced | **0 bytes** |
| etcd quorum lost | never (2/3 held throughout) |
| Downtime to services | none (everything HA across the other two nodes) |
| Old 990 | in my hand, intact — instant rollback if I'd needed it |

One node migrated onto a datacenter SSD, the failing consumer drive bagged for the RMA, and — the part Part 1 was really asking — **the failure mode is structurally gone.** No more consumer NAND doing fsync-heavy etcd work without power-loss protection. The PM9A3 has the capacitors; the 990 never did.

So the procedure works. I had a clean runbook, five resolved unknowns, and a node humming on enterprise flash.

Which is precisely the kind of confidence that comes right before the back two nodes find five *new* ways to make you earn it. That's [Part 3](/2026/three-990-pros-all-dying-part-3): node-local data that vaporises on reinstall, an OSD that boots faster than its own network, a database password bug I'd only half-fixed, a restore that raced itself, and a serial number I wrongly swore I couldn't read.
