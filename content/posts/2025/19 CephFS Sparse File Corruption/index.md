---
title: "CephFS Sparse File Corruption: A Data Recovery Story"
description: "How a CephFS sparse file handling quirk silently corrupted my app configs during VolSync restores—and the multi-day recovery effort across qbittorrent, sabnzbd, sonarr, radarr, and filebrowser using a mix of Kopia snapshots and old Restic backups."
date: 2025-12-22
slug: "2025/cephfs-sparse-file-corruption"
toc: true
math: false
draft: false
Tags:
  - CephFS
  - Ceph
  - Volsync
  - Kopia
  - Restic
  - Kubernetes
  - Homelab
  - Data Recovery
Categories: [Storage, Homelab, Backups]
---

> "Your backups are only as good as your last successful restore."

## The Discovery

It started with qbittorrent refusing to authenticate. After the Ceph Reef to Tentacle upgrade, several apps needed restoring from backups. Routine stuff—trigger the VolSync ReplicationDestination, wait for completion, scale up the app.

Except the restored data was garbage.

```bash
$ kubectl exec -n downloads deploy/qbittorrent -c app -- cat /config/qBittorrent/qBittorrent.conf
[Preferences]
WebUI\Username=^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@^@...
```

That's not a username. That's null bytes. The entire config file was zeroed out—the file existed, had the right size, but contained nothing but `0x00` characters.

## The Pattern Emerges

Checking other apps revealed the same problem:

```bash
# Sabnzbd - entire config gone
$ kubectl exec -n downloads deploy/sabnzbd -- ls -la /config/
total 4
drwxr-xr-x 3 apps apps   22 Dec 22 10:15 .
drwxr-xr-x 1 root root 4096 Dec 22 10:15 ..
drwx------ 2 apps apps    6 Dec 22 10:15 lost+found

# Radarr - config.xml zeroed
$ kubectl exec -n downloads deploy/radarr -- head -c 50 /config/config.xml | xxd
00000000: 0000 0000 0000 0000 0000 0000 0000 0000  ................
00000010: 0000 0000 0000 0000 0000 0000 0000 0000  ................
```

The common factor: all these PVCs were on `ceph-filesystem` storage class and had been restored via VolSync.

## Understanding the Bug

CephFS handles sparse files differently than traditional filesystems. A sparse file is one where regions of null bytes aren't actually stored on disk—they're just metadata saying "this region is empty."

The problem: when VolSync's Kopia mover restores files to CephFS, something in the sparse file handling chain goes wrong. Files that should contain data get their content replaced with null bytes, while maintaining their original size and metadata.

This isn't a VolSync bug or a Kopia bug. It's a quirk of how CephFS handles certain write patterns during restore operations. The same restore to `ceph-block` storage works perfectly.

## The Damage Assessment

After checking all apps that used `ceph-filesystem` with VolSync backups:

| App | Status | Impact |
|-----|--------|--------|
| qbittorrent | Config zeroed | Lost WebUI credentials, port settings |
| sabnzbd | Empty directory | Lost entire config, server settings |
| sonarr | Config zeroed | Minimal (uses PostgreSQL for data) |
| sonarr-uhd | Config zeroed | Minimal (uses PostgreSQL for data) |
| sonarr-foreign | Config zeroed | Minimal (uses PostgreSQL for data) |
| radarr | Config zeroed | Minimal (uses PostgreSQL for data) |
| radarr-uhd | Config zeroed | Minimal (uses PostgreSQL for data) |
| filebrowser | Config zeroed | Lost user settings |

The sonarr and radarr instances were lucky—they store actual data in PostgreSQL, so the zeroed `config.xml` only meant losing some network settings. But qbittorrent and sabnzbd were serious losses.

## Recovery Strategy

The immediate fix was obvious: stop using `ceph-filesystem` for VolSync-backed PVCs. But first, I needed to recover the data.

### Attempt 1: Kopia Snapshots with `previous: N`

Kopia stores multiple snapshots. The `previous` parameter tells the ReplicationDestination to restore an older snapshot:

```yaml
apiVersion: volsync.backube/v1alpha1
kind: ReplicationDestination
metadata:
  name: sabnzbd-test-restore
  namespace: downloads
spec:
  trigger:
    manual: test-restore-1
  kopia:
    repository: sabnzbd-volsync-secret
    destinationPVC: sabnzbd-test
    copyMethod: Snapshot
    snapshotClassName: csi-ceph-block
    storageClassName: ceph-block  # Not ceph-filesystem!
    previous: 3  # Go back 3 snapshots
```

I tried `previous: 3`, `previous: 7`, `previous: 10`, even `previous: 13`. Every single snapshot was empty.

The CephFS corruption happened *before* the Kopia migration. All Kopia snapshots were backing up already-corrupted data.

### Attempt 2: Kopia with `restoreAsOf`

Maybe the corruption was more recent? Kopia's `restoreAsOf` parameter restores from the most recent snapshot before a given timestamp:

```yaml
spec:
  kopia:
    restoreAsOf: "2025-12-10T23:59:59Z"  # Day before Kopia migration
```

Same result. Empty. The corruption predated any Kopia backup.

### Attempt 3: Old Restic Backups

Before migrating to Kopia on December 11th, I had Restic backups going to Backblaze B2. Those old backups might still have good data.

The Restic backup bucket (`nerdz-volsync`) was separate from the Kopia bucket (`nerdz-volsync-kopia`). I still had the credentials in 1Password.

```yaml
apiVersion: volsync.backube/v1alpha1
kind: ReplicationDestination
metadata:
  name: sabnzbd-restic-restore
  namespace: downloads
spec:
  trigger:
    manual: restic-restore
  restic:
    repository: sabnzbd-volsync-restic-secret
    destinationPVC: sabnzbd-test
    copyMethod: Direct
    storageClassName: ceph-block
    restoreAsOf: "2025-12-10T23:59:59Z"
    moverSecurityContext:
      runAsUser: 568
      runAsGroup: 568
      fsGroup: 568
```

```bash
$ kubectl exec debug-pod -- ls -la /mnt/sabnzbd-test/
drwxr-xr-x 5 apps apps  101 Dec 10 03:15 .
-rw-r--r-- 1 apps apps 8234 Dec 10 03:15 sabnzbd.ini
drwxr-xr-x 2 apps apps   45 Dec  9 12:30 admin

$ kubectl exec debug-pod -- grep -A2 "\[servers\]" /mnt/sabnzbd-test/sabnzbd.ini
[servers]
[[Frugal EU]]
host = reader.frugalusenet.com
```

Success! The December 10th Restic backup had the full config with all my Usenet server settings.

## The Recovery Process

### Step 1: Create the Restic Restore Component

I created a one-time-use component specifically for Restic restores:

```yaml
# kubernetes/components/volsync-restic-restore/replicationdestination.yaml
apiVersion: volsync.backube/v1alpha1
kind: ReplicationDestination
metadata:
  name: "${APP}-restic-dst"
spec:
  trigger:
    manual: restore-once
  restic:
    repository: ${APP}-volsync-restic-secret
    destinationPVC: ${APP}
    copyMethod: Direct
    storageClassName: ${VOLSYNC_STORAGECLASS:=ceph-block}
    restoreAsOf: "${RESTIC_RESTORE_AS_OF:=2025-12-10T23:59:59Z}"
```

### Step 2: Migrate Each App to ceph-block

For each affected app:

1. Scale down the deployment
2. Delete the corrupted PVC
3. Create new PVC on `ceph-block`
4. Restore from Restic backup
5. Update ks.yaml to use `ceph-block` going forward
6. Scale up and verify

```bash
# Example for sabnzbd
flux suspend kustomization sabnzbd -n downloads
kubectl scale deploy sabnzbd -n downloads --replicas=0
kubectl delete pvc sabnzbd -n downloads

# Apply the restic restore component
# Wait for ReplicationDestination to complete

flux resume kustomization sabnzbd -n downloads
```

### Step 3: Verify and Create Fresh Backups

After confirming each app had valid data, I triggered fresh backups to all three destinations:

```bash
# NFS backup
kubectl patch replicationsource sabnzbd -n downloads --type=merge \
  -p '{"spec":{"trigger":{"manual":"fresh-backup-nfs"}}}'

# Backblaze B2 backup
kubectl patch replicationsource sabnzbd-b2 -n downloads --type=merge \
  -p '{"spec":{"trigger":{"manual":"fresh-backup-b2"}}}'

# Cloudflare R2 backup
kubectl patch replicationsource sabnzbd-r2 -n downloads --type=merge \
  -p '{"spec":{"trigger":{"manual":"fresh-backup-r2"}}}'
```

## The Flux Alert Spam

After fixing all the apps, I got bombarded with Flux alerts:

```
PersistentVolumeClaim/downloads/sonarr-foreign dry-run failed (Invalid):
PersistentVolumeClaim 'sonarr-foreign' is invalid: spec: Forbidden: spec is immutable
```

The volsync component's PVC template includes a `dataSourceRef` pointing to the ReplicationDestination. For existing PVCs, this causes a conflict—you can't add a dataSourceRef after creation.

The fix was adding the `IfNotPresent` SSA label to the PVC template:

```yaml
# kubernetes/components/volsync/nfs-truenas/pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${APP}
  labels:
    kustomize.toolkit.fluxcd.io/ssa: IfNotPresent  # Don't update if exists
spec:
  dataSourceRef:
    kind: ReplicationDestination
    apiGroup: volsync.backube
    name: ${APP}-dst
```

This tells Flux: "Create this PVC if it doesn't exist, but don't try to update existing ones."

## Lessons Learned

| Assumption | Reality |
|------------|---------|
| CephFS works fine for all workloads | Sparse file handling during restores can corrupt data |
| Kopia backups are good if they complete | They can back up already-corrupted data perfectly |
| `previous: N` is a time machine | Only if the data was good when backed up |
| Old backup systems can be deleted after migration | Keep them until you've verified restores work |
| All my apps use PostgreSQL for data | qbittorrent and sabnzbd use local config files |

### The 3-2-1-1 Backup Strategy

After this incident, I've upgraded from 3-2-1 to 3-2-1-1:

- **3** copies of data
- **2** different storage types
- **1** offsite copy
- **1** air-gapped or delayed-deletion copy

The old Restic backups in B2 were essentially an air-gapped backup—I hadn't deleted them after the Kopia migration. That laziness saved my data.

### Storage Class Selection

Going forward, all VolSync-backed PVCs use `ceph-block`:

| Use Case | Storage Class |
|----------|---------------|
| App config/data backed by VolSync | `ceph-block` |
| Shared working storage (media processing) | `ceph-filesystem` |
| Databases (backed by pgBackRest) | `ceph-block` |
| Temporary/cache data | `openebs-hostpath` |

CephFS is still useful for ReadWriteMany workloads where multiple pods need access to the same files. Just don't use it for data that needs to survive restore operations.

## Quick Reference

```bash
# Check for sparse file corruption
kubectl exec -n <namespace> deploy/<app> -- od -c /config/config.xml | head -5
# If you see "0000000  \0  \0  \0  \0..." - it's zeroed

# Restore from old Restic backup
# 1. Create secret with old Restic credentials
kubectl create secret generic ${APP}-volsync-restic-secret \
  --from-literal=RESTIC_REPOSITORY=s3:s3.us-east-005.backblazeb2.com/nerdz-volsync/${APP} \
  --from-literal=RESTIC_PASSWORD=<password> \
  --from-literal=AWS_ACCESS_KEY_ID=<key> \
  --from-literal=AWS_SECRET_ACCESS_KEY=<secret> \
  -n <namespace>

# 2. Create ReplicationDestination with restoreAsOf
# 3. Trigger restore with: kubectl patch ... manual: restore-now

# Force fresh backup to all destinations
for suffix in "" "-b2" "-r2"; do
  kubectl patch replicationsource ${APP}${suffix} -n <namespace> --type=merge \
    -p '{"spec":{"trigger":{"manual":"fresh-'$(date +%s)'"}}}'
done

# Check backup status
kubectl get replicationsource -n <namespace>
```

## Final Thoughts

Data corruption is insidious. The files looked normal—right names, right sizes, right permissions. Only the content was wrong. Without actually reading the files, there was no indication anything was broken.

This is why backup verification matters. Not "did the backup job complete successfully," but "can I actually restore and use the data." I've added a monthly calendar reminder to do test restores.

The silver lining: this forced me to audit all my apps and migrate everything to consistent storage classes. The cluster is more robust now than before the incident.

---

*This post documents the recovery from my [home-ops](https://github.com/gavinmcfall/home-ops) cluster. The original VolSync Kopia migration is documented in my [previous post](/2025/volsync-kopia-migration/).*
