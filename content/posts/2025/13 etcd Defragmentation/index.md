---
title: "Defragmenting etcd in a Talos Kubernetes Cluster"
description: "Why etcd fragments over time and how to reclaim disk space with talosctl etcd defrag."
date: 2025-12-11
slug: "2025/etcd-defragmentation"
toc: true
math: false
draft: false
Tags:
  - etcd
  - Talos
  - Kubernetes
  - Homelab
  - Maintenance
Categories: [Kubernetes, Homelab]
---

> "Your 100MB of data living in a 250MB file is not a feature."

## The Alert

Got this from AlertManager:

```
etcd cluster "kube-etcd": database size in use on instance 10.90.3.101:2381 is 46.35% of the actual allocated disk space, please run defragmentation (e.g. etcdctl defrag) to retrieve the unused fragmented disk space.
```

Time to learn what etcd fragmentation actually means.

## Why Does etcd Fragment?

etcd stores all Kubernetes state—every pod, deployment, secret, and configmap lives here. Under the hood, it uses a B+ tree data structure backed by an **append-only write-ahead log** (WAL).

Here's the key insight: when you delete or update a key in etcd, the old data isn't removed from disk. It's just marked as free space. The database file grows but never shrinks on its own.

Three things constantly churn etcd in a Kubernetes cluster:

1. **Pod scheduling**: Every pod creation, update, and deletion writes to etcd
2. **Controller loops**: Controllers constantly reconciling state means constant writes
3. **Lease renewals**: Kubelet heartbeats, leader elections, and endpoint updates

The Kubernetes API server runs automatic **compaction**, which removes old revisions of keys (you don't need 1000 historical versions of a ConfigMap). But compaction just marks space as reusable—it doesn't actually free it.

Over time, your database file becomes Swiss cheese: actual data scattered among holes of freed space. This is fragmentation.

## Checking the Damage

In Talos, checking etcd status is straightforward:

```bash
$ talosctl -n 10.90.3.101,10.90.3.102,10.90.3.103 etcd status

NODE          MEMBER             DB SIZE   IN USE            LEADER
10.90.3.101   4b0c33136dd72672   259 MB    119 MB (45.93%)   f0f9525a77920d83
10.90.3.102   f0f9525a77920d83   262 MB    119 MB (45.28%)   f0f9525a77920d83
10.90.3.103   cd15b67489885c40   267 MB    119 MB (44.49%)   f0f9525a77920d83
```

All three control plane nodes were using less than 50% of their allocated space. The rest? Fragmented free space doing nothing but wasting disk I/O.

## The Fix

Defragmentation rewrites the database file compactly, eliminating the holes. In Talos, it's a single command.

### Step 1: Snapshot First

Paranoia is healthy when touching cluster state:

```bash
talosctl -n 10.90.3.101 etcd snapshot /tmp/etcd-backup-$(date +%Y%m%d).snapshot
```

This creates a consistent backup you can restore from if something goes wrong.

### Step 2: Defrag Each Node Sequentially

Defrag briefly blocks reads and writes on that node, so you want to do one at a time. Best practice: **non-leader nodes first, leader last**.

To find the leader, look at the `LEADER` column in the status output. It shows the member ID of the current leader (`f0f9525a77920d83`). Then match that to the `MEMBER` column to find which node it is:

```bash
$ talosctl -n 10.90.3.101,10.90.3.102,10.90.3.103 etcd status

NODE          MEMBER             DB SIZE   IN USE            LEADER
10.90.3.101   4b0c33136dd72672   259 MB    119 MB (45.93%)   f0f9525a77920d83
10.90.3.102   f0f9525a77920d83   262 MB    119 MB (45.28%)   f0f9525a77920d83  <-- MEMBER matches LEADER
10.90.3.103   cd15b67489885c40   267 MB    119 MB (44.49%)   f0f9525a77920d83
```

Node `10.90.3.102` has member ID `f0f9525a77920d83`, which matches the leader ID. So that's our leader.

Now defrag:

```bash
# Non-leaders first
talosctl -n 10.90.3.101 etcd defrag
talosctl -n 10.90.3.103 etcd defrag

# Leader last
talosctl -n 10.90.3.102 etcd defrag
```

Each defrag takes just a few seconds for a database this size.

### Step 3: Verify

```bash
$ talosctl -n 10.90.3.101,10.90.3.102,10.90.3.103 etcd status

NODE          DB SIZE   IN USE              LEADER
10.90.3.101   104 MB    104 MB (100.00%)    f0f9525a77920d83
10.90.3.102   104 MB    104 MB (100.00%)    f0f9525a77920d83
10.90.3.103   104 MB    104 MB (100.00%)    f0f9525a77920d83
```

~160MB reclaimed per node. 100% utilization means zero fragmentation.

## When to Defrag

The general guidance:

- **Below 50% utilization**: Defrag recommended
- **NOSPACE errors**: Defrag required (etcd will refuse writes when it hits its quota)

For homelabs, waiting for the Prometheus alert is fine. Production clusters might schedule it monthly or watch the metric more closely.

## What If You Hit NOSPACE?

If etcd hits its space quota before you defrag, it enters a read-only mode to protect data integrity. You'll need to:

1. Defrag to free space
2. Clear the alarm: `talosctl etcd alarm disarm`

If you're consistently hitting the quota, you can increase it in your Talos machine config:

```yaml
cluster:
  etcd:
    extraArgs:
      quota-backend-bytes: "4294967296"  # 4 GiB
```

## References

- [Talos etcd Maintenance](https://www.talos.dev/v1.11/advanced/etcd-maintenance/)
- [etcd Maintenance Documentation](https://etcd.io/docs/v3.5/op-guide/maintenance/)
