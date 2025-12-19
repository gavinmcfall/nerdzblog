---
title: "Upgrading Ceph from Reef to Squid in a Rook-Managed Cluster"
description: "A real-world walkthrough of upgrading Ceph from v18 (Reef) to v19 (Squid) via GitOps, including the Rook version constraints that make direct upgrades to Tentacle impossible—for now."
date: 2025-12-20
slug: "2025/ceph-reef-to-squid-upgrade"
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

> "You can't skip Ceph versions, and you can't ignore Rook compatibility. Ask me how I learned this."

## The Situation

Reef (v18) end-of-life is August 2025. Tentacle (v20) shipped in November 2025. Time to upgrade, right?

Not so fast.

I initially wrote a combined "Reef to Tentacle" upgrade guide, planning to do both hops in sequence. Then I actually read the Rook compatibility matrix.

## The Rook Constraint

Here's the problem nobody tells you upfront: **Rook version determines which Ceph versions you can run**.

| Rook Version | Supported Ceph Versions |
|--------------|------------------------|
| v1.17.x | Reef only |
| v1.18.x | Reef + Squid |
| v1.19+ | Squid + Tentacle (drops Reef) |

The upgrade path looks simple on paper:

```
Reef (v18) → Squid (v19) → Tentacle (v20)
```

But Rook v1.19 isn't released yet. It's targeted for December 2025 per the [Rook roadmap](https://github.com/rook/rook/blob/master/ROADMAP.md). That means:

1. **Right now** (Rook v1.18.x): You can upgrade Reef → Squid
2. **After Rook v1.19 releases**: You can upgrade Squid → Tentacle
3. **Never**: Skip Squid and go directly Reef → Tentacle

This isn't a Ceph limitation—Ceph itself can upgrade through any supported path. It's a **Rook limitation**. The operator explicitly checks Ceph versions and refuses to proceed if it doesn't recognize them.

## My Starting Point

```bash
$ kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph version
ceph version 18.2.7 (2cf3b0098dc3cbb1b6f2e8d8ed9df8c65b6aee53) reef (stable)

$ kubectl -n rook-ceph get deploy rook-ceph-operator -o jsonpath='{.spec.template.spec.containers[0].image}'
ghcr.io/rook/rook:v1.18.8
```

Reef v18.2.7 on Rook v1.18.8. Good to go for Squid.

## The Upgrade

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

```
$ kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph versions
{
    "mon": {
        "ceph version 19.2.3 (...) squid (stable)": 3
    },
    "mgr": {
        "ceph version 19.2.3 (...) squid (stable)": 2
    },
    "osd": {
        "ceph version 19.2.3 (...) squid (stable)": 3
    },
    "mds": {
        "ceph version 19.2.3 (...) squid (stable)": 2
    },
    "rgw": {
        "ceph version 19.2.3 (...) squid (stable)": 2
    }
}
```

### Step 6: Finalize the Upgrade

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

Done. Cluster is on Squid and healthy.

## What About the Toolbox?

One thing that caught me off guard: the Ceph toolbox doesn't auto-upgrade with the cluster. It's a separate deployment.

```bash
$ kubectl -n rook-ceph get deploy rook-ceph-tools -o jsonpath='{.spec.template.spec.containers[0].image}'
quay.io/ceph/ceph:v19.2.3-20250717
```

In my case, Rook had already updated it. But if yours is still on the old version:

```bash
kubectl -n rook-ceph set image deploy/rook-ceph-tools rook-ceph-tools=quay.io/ceph/ceph:v19.2.3-20250717
```

Using mismatched toolbox and cluster versions can cause confusing behavior—the CLI tools might not understand newer cluster features.

## Breaking Changes I Reviewed

Before upgrading, I checked the [Squid release notes](https://docs.ceph.com/en/latest/releases/squid/) for breaking changes:

| Change | Impact on My Cluster |
|--------|---------------------|
| RGW timestamps truncated to seconds | Object storage timestamps may briefly appear to move backwards. Transient, no action needed. |
| CephFS `fs rename` requires offline | Not renaming filesystems. No impact. |
| OSD shard defaults changed (HDD only) | Using NVMe SSDs. No impact. |
| iSCSI bug (Issue #68215) | Not using iSCSI. No impact. |

My NVMe-optimized `configOverride` settings are fully compatible with Squid:

```yaml
configOverride: |
  [global]
  bdev_enable_discard = true
  bdev_async_discard = true
  osd_class_update_on_start = false
  bluestore_min_alloc_size = 4096
```

## What's Next: Waiting for Rook v1.19

Tentacle (v20) has been out since November 2025, but I can't upgrade yet. Rook v1.18.x doesn't support it—you get an "unsupported version" error if you try.

The Rook roadmap targets v1.19 for December 2025. Once that releases:

1. Upgrade Rook from v1.18.x to v1.19.x
2. Then upgrade Ceph from Squid to Tentacle using the same process

I've already written the [Squid to Tentacle guide](https://github.com/gavinmcfall/home-ops/tree/main/docs/Guides/Storage/Ceph%20Upgrade%20-%20Squid%20to%20Tentacle) in anticipation.

## Lessons Learned

| Assumption | Reality |
|------------|---------|
| Can upgrade Reef → Tentacle directly | Must go Reef → Squid → Tentacle, one version at a time |
| Rook supports all current Ceph versions | Each Rook release supports only 2 consecutive Ceph versions |
| Toolbox auto-upgrades with cluster | Separate deployment, may need manual update |
| Generic version tags are fine | Use build-specific tags (e.g., `v19.2.3-20250717`) for reproducibility |

## Quick Reference

```bash
# Check current versions
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph version
kubectl -n rook-ceph get deploy rook-ceph-operator -o jsonpath='{.spec.template.spec.containers[0].image}'

# Set/unset safety flags
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd set noout
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd unset noout

# Finalize upgrade (NO UNDO)
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd require-osd-release squid

# Check health
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph pg stat
```

## References

- [Rook Ceph Upgrade Guide](https://rook.io/docs/rook/latest-release/Upgrade/ceph-upgrade/)
- [Ceph Squid Release Notes](https://docs.ceph.com/en/latest/releases/squid/)
- [Rook Roadmap](https://github.com/rook/rook/blob/master/ROADMAP.md)
- [Quay.io Ceph Tags](https://quay.io/repository/ceph/ceph?tab=tags)

---

*The upgrade guides are in my [home-ops](https://github.com/gavinmcfall/home-ops) repository under `docs/Guides/Storage/`. I'll update this post when Rook v1.19 releases and I complete the Squid → Tentacle hop.*
