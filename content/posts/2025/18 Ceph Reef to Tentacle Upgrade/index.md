---
title: "Upgrading Ceph from Reef to Tentacle in a Rook-Managed Cluster"
description: "A real-world walkthrough of upgrading Ceph from v18 (Reef) through v19 (Squid) to v20 (Tentacle) via GitOps—including the correction of my wrong assumptions about Rook version constraints."
date: 2025-12-20
slug: "2025/ceph-reef-to-tentacle-upgrade"
toc: true
math: false
draft: false
Tags:
  - Ceph
  - Rook
  - Kubernetes
  - Homelab
  - Storage
  - GitOps
Categories: [Storage, Homelab]
---

> "You can't skip Ceph versions. But you can be wrong about Rook constraints."

## The Situation

Reef (v18) end-of-life is August 2025. Tentacle (v20) shipped in November 2025. Time to upgrade.

I initially wrote a combined "Reef to Tentacle" upgrade guide, planning to do both hops in sequence. Then I read the Rook compatibility matrix and concluded I needed to wait for Rook v1.19 to get Tentacle support.

**I was wrong.**

## The Rook Constraint (Corrected)

Here's what I originally thought:

| Rook Version | Supported Ceph Versions |
|--------------|------------------------|
| v1.17.x | Reef only |
| v1.18.x | Reef + Squid |
| v1.19+ | Squid + Tentacle (drops Reef) |

**The reality:** Rook v1.18.8 added Tentacle support. You don't need to wait for v1.19.

From [this blog post](https://blog.nuvotex.de/ceph-20-2-0-tentacle-released/):
> "If you're running Ceph within Kubernetes using Rook Ceph, and you want to use Tentacle without the unsupported flag, you need to update at least to version v1.18.8."

So the actual support matrix is:

| Rook Version | Supported Ceph Versions |
|--------------|------------------------|
| v1.18.0 - v1.18.7 | Reef + Squid |
| v1.18.8+ | Reef + Squid + Tentacle |

The upgrade path still requires going through Squid—you can't skip versions—but you can do both hops on Rook v1.18.8.

## My Starting Point

```bash
$ kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph version
ceph version 18.2.7 (2cf3b0098dc3cbb1b6f2e8d8ed9df8c65b6aee53) reef (stable)

$ kubectl -n rook-ceph get deploy rook-ceph-operator -o jsonpath='{.spec.template.spec.containers[0].image}'
ghcr.io/rook/ceph:v1.18.8
```

Reef v18.2.7 on Rook v1.18.8. Good to go for the full journey.

---

## Phase 1: Reef to Squid

### Step 1: Backup Everything

Ceph upgrades are one-way. Once you run `require-osd-release squid`, there's no going back to Reef.

```bash
BACKUP_DIR=~/backups/ceph/migration-$(date +%Y%m%d)
mkdir -p $BACKUP_DIR

# Cluster state
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph status > $BACKUP_DIR/ceph-status.txt
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree > $BACKUP_DIR/osd-tree.txt
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd crush dump > $BACKUP_DIR/crush-map.json
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config dump > $BACKUP_DIR/config-dump.txt
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph versions > $BACKUP_DIR/versions.txt

# Kubernetes resources
kubectl -n rook-ceph get cephcluster -o yaml > $BACKUP_DIR/cephcluster.yaml
kubectl get pods -n rook-ceph -o wide > $BACKUP_DIR/pods.txt
kubectl get pvc -A | grep -E "ceph-block|ceph-filesystem" > $BACKUP_DIR/pvcs.txt
```

### Step 2: Set Safety Flags

These prevent Ceph from marking OSDs as "out" and rebalancing data during the rolling restart:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd set noout
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd set norebalance

# Verify
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd dump | grep flags
# flags noout,norebalance
```

Without these flags, Ceph gets nervous when daemons restart and starts shuffling data around. That slows down the upgrade and adds risk.

### Step 3: Update the HelmRelease

The actual change is one line:

```yaml
# kubernetes/apps/rook-ceph/rook-ceph/cluster/helmrelease.yaml
cephClusterSpec:
  cephVersion:
    image: quay.io/ceph/ceph:v19.2.3-20250717  # Was v18.2.7
    allowUnsupported: false
```

Note the build-specific tag (`v19.2.3-20250717`). Don't use just `v19.2.3`—the build suffix ensures you get a specific, tested image rather than whatever "latest v19.2.3" happens to be.

### Step 4: Deploy via GitOps

```bash
git add kubernetes/apps/rook-ceph/rook-ceph/cluster/helmrelease.yaml
git commit -m "feat(rook-ceph): upgrade Ceph from Reef v18.2.7 to Squid v19.2.3"
git push
```

Flux picks up the change and triggers Rook to start the rolling upgrade.

### Step 5: Watch the Rolling Upgrade

Rook upgrades daemons in a specific order: MON → MGR → MDS → OSD → RGW.

```bash
# Terminal 1: Watch pods
kubectl -n rook-ceph get pods -w

# Terminal 2: Watch Ceph status
watch -n 10 'kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s'

# Periodically check versions
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph versions
```

During the upgrade, you'll see brief `HEALTH_WARN` states as daemons restart. This is normal. Only worry if you see `HEALTH_ERR` persisting for more than 10 minutes.

My 3-node cluster upgraded in about 3 minutes:

```json
{
    "mon": { "ceph version 19.2.3 (...) squid (stable)": 3 },
    "mgr": { "ceph version 19.2.3 (...) squid (stable)": 2 },
    "osd": { "ceph version 19.2.3 (...) squid (stable)": 3 },
    "mds": { "ceph version 19.2.3 (...) squid (stable)": 2 },
    "rgw": { "ceph version 19.2.3 (...) squid (stable)": 2 }
}
```

### Step 6: Finalize the Squid Upgrade

This step is critical. It tells Ceph that all OSDs are now Squid-capable, enabling Squid-specific features:

```bash
# Check current state
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd dump | grep require_osd_release
# require_osd_release reef

# Set Squid requirement (NO GOING BACK AFTER THIS)
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd require-osd-release squid

# Verify
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd dump | grep require_osd_release
# require_osd_release squid
```

### Step 7: Unset Safety Flags

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd unset noout
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd unset norebalance
```

### Step 8: Verify Health

```bash
$ kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
HEALTH_OK

$ kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph pg stat
169 pgs: 169 active+clean
```

Phase 1 complete. Cluster is on Squid and healthy.

---

## Phase 2: Squid to Tentacle

After running Squid stably for a while (in my case, a few hours—I was impatient), I proceeded with the Tentacle upgrade.

### Tentacle Breaking Changes

Before upgrading, I checked the [Tentacle release notes](https://docs.ceph.com/en/latest/releases/tentacle/) for breaking changes:

| Change | Impact on My Cluster |
|--------|---------------------|
| RGW tenant-level IAM deprecated | Not using tenant IAM. No impact. |
| `restful` mgr module removed | Not using REST API module. No impact. |
| `zabbix` mgr module removed | Not using Zabbix. No impact. |
| Erasure coding default changed to ISA-L | Only affects new pools. Existing pools unchanged. |
| `osd_repair_during_recovery` option removed | Not in my config. No impact. |

### Step 1: Backup Again

Same process, new directory:

```bash
BACKUP_DIR=~/backups/ceph/squid-to-tentacle-$(date +%Y%m%d)
mkdir -p $BACKUP_DIR

kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph status > $BACKUP_DIR/ceph-status.txt
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree > $BACKUP_DIR/osd-tree.txt
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd crush dump > $BACKUP_DIR/crush-map.json
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config dump > $BACKUP_DIR/config-dump.txt
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph versions > $BACKUP_DIR/versions.txt
kubectl -n rook-ceph get cephcluster -o yaml > $BACKUP_DIR/cephcluster.yaml
kubectl get pods -n rook-ceph -o wide > $BACKUP_DIR/pods.txt
```

### Step 2: Set Safety Flags

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd set noout
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd set norebalance
```

### Step 3: Update HelmRelease to Tentacle

```yaml
# kubernetes/apps/rook-ceph/rook-ceph/cluster/helmrelease.yaml
cephClusterSpec:
  cephVersion:
    image: quay.io/ceph/ceph:v20.2.0-20251104  # Was v19.2.3-20250717
    allowUnsupported: false
```

### Step 4: Deploy via GitOps

```bash
git add kubernetes/apps/rook-ceph/rook-ceph/cluster/helmrelease.yaml
git commit -m "feat(rook-ceph): upgrade Ceph from Squid v19.2.3 to Tentacle v20.2.0"
git push
```

### Step 5: Watch the Rolling Upgrade

Same monitoring as before:

```bash
kubectl -n rook-ceph get pods -w
watch -n 10 'kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s'
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph versions
```

The upgrade took about 3-4 minutes. I watched the versions transition:

```
MONs: 2/3 Tentacle... 3/3 Tentacle ✓
MGRs: 0/2 Tentacle... 2/2 Tentacle ✓
MDS:  0/2 Tentacle... 2/2 Tentacle ✓
OSDs: 0/3 Tentacle... 1/3... 2/3... 3/3 Tentacle ✓
RGWs: 0/2 Tentacle... 1/2... 2/2 Tentacle ✓
```

Final state:

```json
{
    "mon": { "ceph version 20.2.0 (...) tentacle (stable)": 3 },
    "mgr": { "ceph version 20.2.0 (...) tentacle (stable)": 2 },
    "osd": { "ceph version 20.2.0 (...) tentacle (stable)": 3 },
    "mds": { "ceph version 20.2.0 (...) tentacle (stable)": 2 },
    "rgw": { "ceph version 20.2.0 (...) tentacle (stable)": 2 }
}
```

### Step 6: Finalize the Tentacle Upgrade

Interestingly, this was already set automatically:

```bash
$ kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd dump | grep require_osd_release
require_osd_release tentacle
```

Rook must have set it after detecting all OSDs were on Tentacle. If yours isn't set:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd require-osd-release tentacle
```

### Step 7: Unset Safety Flags

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd unset noout
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd unset norebalance
```

### Step 8: Final Health Check

```bash
$ kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
HEALTH_OK

$ kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
  cluster:
    id:     3b3d504b-96b4-4102-9ce3-c91b6bc2948d
    health: HEALTH_OK

  services:
    mon: 3 daemons, quorum a,b,c (age 6m)
    mgr: b(active, since 5m), standbys: a
    mds: 1/1 daemons up, 1 hot standby
    osd: 3 osds: 3 up (since 2m), 3 in (since 4w)
    rgw: 2 daemons active (2 hosts, 1 zones)

  data:
    volumes: 1/1 healthy
    pools:   12 pools, 169 pgs
    objects: 55.48k objects, 104 GiB
    usage:   305 GiB used, 4.9 TiB / 5.2 TiB avail
    pgs:     169 active+clean
```

Done. Reef → Squid → Tentacle complete.

---

## What About the Toolbox?

One thing that caught me off guard during Reef → Squid: the Ceph toolbox doesn't auto-upgrade with the cluster. It's a separate deployment.

Turns out Rook does update it automatically now (at least in v1.18.8). But if yours is still on an old version:

```bash
kubectl -n rook-ceph set image deploy/rook-ceph-tools rook-ceph-tools=quay.io/ceph/ceph:v20.2.0-20251104
```

Using mismatched toolbox and cluster versions can cause confusing behavior—the CLI tools might not understand newer cluster features.

## Lessons Learned

| Assumption | Reality |
|------------|---------|
| Can upgrade Reef → Tentacle directly | Must go Reef → Squid → Tentacle, one version at a time |
| Need Rook v1.19 for Tentacle | Rook v1.18.8 already supports Tentacle |
| Toolbox auto-upgrades with cluster | It does now, but verify anyway |
| Generic version tags are fine | Use build-specific tags (e.g., `v20.2.0-20251104`) for reproducibility |
| `require_osd_release` needs manual setting | Rook set it automatically for Tentacle (but verify) |

## Quick Reference

```bash
# Check current versions
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph version
kubectl -n rook-ceph get deploy rook-ceph-operator -o jsonpath='{.spec.template.spec.containers[0].image}'

# Set/unset safety flags
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd set noout
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd set norebalance
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd unset noout
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd unset norebalance

# Finalize upgrade (NO UNDO)
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd require-osd-release tentacle

# Check health
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph pg stat
```

## References

- [Rook Ceph Upgrade Guide](https://rook.io/docs/rook/latest-release/Upgrade/ceph-upgrade/)
- [Ceph Squid Release Notes](https://docs.ceph.com/en/latest/releases/squid/)
- [Ceph Tentacle Release Notes](https://docs.ceph.com/en/latest/releases/tentacle/)
- [Quay.io Ceph Tags](https://quay.io/repository/ceph/ceph?tab=tags)
- [Tentacle + Rook v1.18.8 Blog Post](https://blog.nuvotex.de/ceph-20-2-0-tentacle-released/)

---

*The upgrade guides are in my [home-ops](https://github.com/gavinmcfall/home-ops) repository under `docs/Guides/Storage/`.*
