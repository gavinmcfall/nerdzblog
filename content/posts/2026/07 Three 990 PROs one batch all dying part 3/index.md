---
title: "Three 990 PROs, One Batch, All Dying — Part 3: The Part Where the Canary Lied"
description: "The canary migration went perfectly, so I ran the same playbook on the last two nodes. They found five new ways to make me earn it — node-local data that vaporises on reinstall, an OSD that booted faster than its network, a password bug I'd only half-fixed, a restore that raced itself, and a serial number I wrongly swore I couldn't read."
date: 2026-05-26
slug: "2026/three-990-pros-all-dying-part-3"
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
  - OpenEBS
  - Prometheus
  - Kubernetes
  - Homelab
Categories: [Hardware, Homelab]
---

> In [Part 2](/2026/three-990-pros-all-dying-part-2) the canary went so cleanly I ended by saying the procedure works. Reader, that was the confidence that comes right before the other two nodes teach you things.

The procedure itself held up perfectly. stanton-01 and stanton-03 both drained, dropped their etcd member, pulled the 990, booted the PM9A3 from a USB stick, reinstalled, and rejoined — etcd 3/3, Ceph `HEALTH_OK`, OSD re-adopted with zero data movement, exactly like the canary promised.

What the canary *didn't* teach me is that a control-plane node carries a surprising amount of state that lives **only** on that node — and a fresh install wipes `/var` to bare metal. Five separate things broke or surprised me on the back two nodes. None of them were the disk swap. All of them were worth writing down.

## 1. The data that lives on the node (and dies with it)

Talos's `EPHEMERAL` partition is `/var`, and on these nodes `/var/openebs/local` is where the **OpenEBS hostpath** PVCs live — node-pinned, single-copy volumes. A reinstall doesn't migrate them. It vaporises them.

I knew the CNPG replicas would need rebuilding (they stream fresh from the primary — a non-event). What I'd underweighted was everything *else* on node-local storage. After stanton-01 came back, a handful of pods were stuck:

```
loki-0          ContainerCreating
alertmanager-0  Init:0/1
```

```
MountVolume.NewMounter ... path "/var/openebs/local/pvc-9713ea45-…" does not exist
```

The PV object still existed in Kubernetes; its backing directory on the node did not. OpenEBS won't recreate the directory for an *already-provisioned* PV, so the pod sits there forever, politely failing to mount a thing that no longer exists.

Loki and Alertmanager are single-instance. There's no replica to stream from. If I wiped the node, that history was simply **gone** — unless I'd taken it off the node first.

So before each wipe, I backed up the at-risk node-local volumes to the NAS with a dead-simple privileged pod: mount the node's `/var/openebs/local` read-only on one side, an NFS share on the other, `tar` the directories across. (A couple of things I learned the hard way: TrueNAS NFS root-squashes to a fixed UID, so the tarballs land owned by `apps` and you don't fight permissions; `showmount` isn't on TrueNAS SCALE; and `chmod` over SSH bounces off the NFSv4 ACLs — read `/etc/exports` directly and lean on the squash.)

The restore is the neat part. Rather than fight OpenEBS to re-provision, I just **recreated the exact directory the PV expected and unpacked the backup into it**:

```bash
mkdir -p /var/openebs/local/pvc-9713ea45-…   # the path the mount was crying about
tar xf loki_….tar -C /var/openebs/local/pvc-9713ea45-…
```

Next mount retry, the kubelet finds a populated directory, and Loki starts on its restored history like nothing happened. For the genuinely throwaway volumes (VolSync caches — ~67 of them on stanton-03 alone), I just `mkdir`'d empty directories; VolSync refills them on the next sync. Empty dir for caches, restored dir for data, skip the freshly-provisioned CNPG dirs. One pass.

The lesson is blunt: **on a hyperconverged node, "reinstall the OS" and "destroy the node-local data" are the same sentence.** Know what's single-copy and on `/var` before you pull the trigger. For me that was Loki, Alertmanager, and Prometheus — everything else was replicated, on the NAS, or rebuildable.

## 2. The OSD that booted faster than its network

stanton-03 reinstalled fine, etcd rejoined, the mon came back — and then its Ceph OSD went into `CrashLoopBackOff`. New behaviour; the first two nodes re-adopted their OSDs without a hiccup.

```
-1 unable to find any IPv4 address in networks '169.254.255.0/24' interfaces ''
-1 Failed to pick cluster address.
```

My Ceph **cluster_network** runs over the Thunderbolt mesh between the three MS-01s — the same fragile TB ring that turned a single dead disk into a four-hour incident back in [Part 1](/2026/three-990-pros-all-dying-part-1), and that I'm in the middle of migrating off entirely (a story for another post). The OSD needs an address on `169.254.255.0/24` to bind. On a freshly-booted node, the OSD container started **before** Thunderbolt had finished negotiating and getting its address. No address, no bind, crash.

The fix was almost embarrassingly simple once I understood it: wait for Thunderbolt to come up (`talosctl get addresses` shows the `169.254.255.x` land on the `enx…` interfaces), then delete the crash-looping OSD pod so it restarts into a network that now exists. Up `2/2`, re-adopted, `169 active+clean`.

Worth flagging because it's a pure **ordering** bug, not a config error — the same manifest that worked on two nodes "failed" on the third purely because a USB-ish interface took a few extra seconds to wake up. If your Ceph cluster network rides on something that negotiates slowly, expect this on a cold node and don't panic.

## 3. The bug I thought I'd fixed

Then five app pods fell over at once, all with the same error:

```
FATAL:  password authentication failed for user "postgres"
```

This is my CloudNativePG cluster's original sin: it was bootstrapped with `owner: postgres` — the database owner *is* the superuser. That gives CNPG two independent reconcile paths that both write the `postgres` role's password, and they don't always agree. Restart a node, rebuild some instances, fail a primary over a few times — exactly what a disk migration does — and the live password drifts off what the apps hold. The apps, holding the right value, get rejected.

Here's the honest part. A while back I "fixed" this. What I *actually* fixed was the **backups** (the [Part 2](/2026/three-990-pros-all-dying-part-2) excavation) and I wrote myself a recovery runbook. I never fixed the **root cause**, because that needs a planned outage to recreate the cluster, and there was always something more urgent. So when the migration churned CNPG hard, the race came back precisely as designed.

The recovery is well-trodden now. A hash comparison (no secrets printed — just `sha256` prefixes) showed all five apps and the 1Password-managed secret agreeing on one value; the live database had drifted off it. So I set the database back to the value everyone else already expected — and, importantly, to the value held in the database's *own* managed secret, so the next reconcile applies the same thing instead of fighting me:

```sql
ALTER USER postgres WITH PASSWORD '…';   -- via a local peer-auth session on the primary
```

Bounce the five pods, they re-run their init against a database that now accepts them, done. **24/24 apps back in agreement.**

But I'm done pretending the recovery *is* the fix. The real fix — migrating the cluster to `owner: app` so the superuser has exactly one password-writer — is now planned, validated end-to-end against a throwaway cluster, and waiting for an outage window. The backups that Part 2 was all about are what finally make me comfortable doing it. Funny how that comes full circle.

## 4. The restore that raced itself

Prometheus was the biggest single-copy volume — ~32 GB of TSDB on stanton-03, backed up before the wipe. After the node came back, I recreated its directory and started unpacking the 32 GB tarball into it.

And while `tar` was still extracting, Prometheus **started**.

The kubelet had been retrying the mount every 20 seconds. The instant my `mkdir` created the directory, the mount succeeded, and the pod launched onto a **half-extracted** TSDB while `tar` was still writing files underneath it. That is a great way to corrupt a time-series database.

I caught it because the pod went `2/2 Running` far too early. Recovery:

1. Scale Prometheus to zero — for an operator-managed Prometheus that means `kubectl patch prometheus … replicas: 0`, *not* scaling the StatefulSet, which the operator just reverts.
2. Empty the directory (`find … -delete` — not `rm -rf`; my own safety tooling slaps that down, rightly).
3. Re-extract cleanly with nothing mounted.
4. Scale back up.

This time it loaded properly — nine healthy blocks, ~31 days of history, clean WAL replay. The lesson: **if you're restoring into a directory a controller is actively trying to mount, stop the controller first.** The kubelet will not wait for your `tar` to finish — it grabs the volume the moment it appears.

## 5. The serial number I said I couldn't read

This one's a personal favourite, because I was wrong and the record should say so.

The pulled 990 PROs are going back as warranty returns, and they held etcd — every secret in the cluster. I wanted to confirm *which* drive was which before wiping, and read each one's real serial. I dropped one into a USB-NVMe dock, asked the OS for the serial, and got the **dock's** serial, not the drive's. I'd hit this on the Talos side too: `smartctl -d sntrealtek` failed, and I concluded the bridge masks the serial and moved on.

Then I actually researched it instead of giving up, and checked the one thing I'd skipped: the bridge's USB ID. `152D:0586`. That's **JMicron**, not Realtek. I'd been handing a JMicron bridge the Realtek passthrough and treating the failure as proof of impossibility.

The right incantation:

```
smartctl -d sntjmicron -a /dev/sdX     # JMicron's NVMe passthrough — needs admin
```

And there it was, straight through the dock:

```
Model Number:   Samsung SSD 990 PRO 1TB
Serial Number:  S73VNU0X303066H
```

Exact match to stanton-01's record. As a bonus, the same call dumps full SMART — and these "fine" consumer drives were at **43% endurance used** with 100 TB written, which is rather the entire point of this three-part saga.

Then the wipe itself tried to take all day. `diskpart clean all` was crawling at **41 MB/s** — textbook USB 2.0. The dock is a 10 Gbps enclosure, so I went hunting, and the culprit was the cable: a premium Anker USB-C–to–USB-C cable that is **USB 2.0 for data**. Loads of "high-end" C-to-C cables are — they're built for charging wattage with only the USB 2.0 data pairs wired, and they look identical to a 10 Gbps cable. A charging cable advertises watts; a data cable advertises 5 or 10 Gbps. Swapped to a proper SSD data cable and the same wipe ran at **~1.35 GB/s** — about 30× faster, ~15 minutes per drive instead of nearly seven hours.

One more trap while aborting the slow wipe: killing the `diskpart` process did **not** stop it. `diskpart clean all` hands the actual zeroing to the **Virtual Disk Service** (`vds`), which keeps grinding after the front-end is gone. To truly stop it you stop VDS — or just unplug the drive, which is perfectly safe when the thing is mid-erase anyway.

All three drives: serial confirmed through the bridge, full-disk zeroed, partition table gone. Ready to ship.

Two takeaways here. **Identify the bridge chip before you decide something's impossible** — the passthrough is chip-specific, and "it didn't work" usually means "wrong passthrough," not "can't be done." And **a USB enclosure isn't an information black hole**: the NVMe device is right there behind a thin translation layer; you just have to speak its dialect.

## What it cost, across all three

| | |
|---|---|
| Nodes migrated to datacenter SSDs | 3 / 3 |
| Ceph data rebalanced | **0 bytes** (re-adopted every time) |
| etcd quorum lost | never (held ≥2/3 throughout) |
| Monitoring history lost | **none** — Prometheus, Loki, Alertmanager all restored |
| Service downtime | none that outlived a pod reschedule |
| Surprises that were the disk swap | **zero** |
| Surprises that were everything *around* the disk swap | five |

The control plane now runs on PM9A3s with power-loss protection and endurance I won't have to think about for years. The structural failure mode from Part 1 — consumer NAND doing fsync-heavy etcd work with no PLP, on hosts with no UPS — is gone. Every consumer 990 PRO is wiped, serial confirmed, and bagged for the RMA.

## Lessons

- **A per-node reinstall on a hyperconverged cluster is a controlled demolition of that node's local state.** Know — *before* you start — exactly what lives on `/var` and how you'll bring it back. Replicated and NAS-backed data is free; single-copy node-local data is not.
- **Verify disks by serial, never by `/dev/nvmeX`.** Device names re-enumerate the moment you pull a drive. The serial follows the hardware.
- **Cold-boot ordering is a real failure class.** If a daemon needs a network that comes up slowly (Thunderbolt, some SFP+), it'll crash on a fresh node and recover on a restart. Don't mistake it for a config error.
- **A bug you fixed by treating the symptom is not fixed.** Write the runbook *and* schedule the root-cause work, or the symptom comes back at the worst time.
- **Quiesce before restoring into a volume a controller wants.** The kubelet doesn't wait for your `tar`.
- **The passthrough is chip-specific.** Check the USB bridge's VID:PID before declaring a serial unreadable; and remember a "premium" C-to-C cable can still be USB 2.0 for data.

The disk swap was the easy part. The education was in the blast radius. The one honest piece of unfinished business is finally migrating that CloudNativePG cluster off `owner: postgres` so the password race can't come back — backups are solid, the procedure's validated, no more excuses. That might even be Part 4.

---

## Update: the blast radius had a seven-hour fuse

A few hours after I'd declared victory, ntfy went off again: **bazarr's VolSync replication was out of date.** And here's the thing — it traced straight back to section 1 of this very post, which I'd apparently failed to fully internalise about my own cluster.

stanton-02 was the **canary**. It was migrated *first*, before I'd worked out the recreate-the-directory restore dance — I only built that step on stanton-01 and reused it on stanton-03. So stanton-02's wiped OpenEBS cache directories were never recreated. They'd been gone the whole time.

The reason it stayed invisible for seven hours is the sneaky part: **VolSync cache PVCs only get mounted when a replication actually fires.** So nothing failed at migration time — it failed lazily, one mover at a time, as each app's schedule came around and hit the same `path … does not exist` wall I described up top. By the time I looked, six movers were silently wedged in `Init` — bazarr, bazarr-foreign, metube, qui, romm, sonarr-uhd — and bazarr's was simply the first stale-replication alert loud enough to notice.

**The symptom**: a VolSync "out of date" / out-of-sync alert hours after a node rebuild, with the mover pod stuck `Init` on `FailedMount: path "/var/openebs/local/pvc-… " does not exist`.

**The fix**: the same trick from section 1, applied to *every* node-local volume on that node at once — recreate all the missing directories in a single pass (empty for caches, restored-from-backup for real data), then delete the wedged movers so they re-run. They all caught up immediately.

**The lesson** — the one I'm adding because I learned it the hard way *after* publishing: when you wipe a hyperconverged node's `/var`, recreate **all** of that node's node-local directories right then, not just the ones actively complaining. The quiet ones aren't fine — they're just waiting for their next scheduled sync to bite you, and they'll do it on a timer you didn't set, hours after you've moved on. The blast radius doesn't always go off at once.
