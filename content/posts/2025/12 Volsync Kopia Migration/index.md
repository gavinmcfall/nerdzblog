---
title: "Migrating Volsync from Restic to Kopia"
description: "How I migrated my Kubernetes PVC backups from Restic to Kopia with a 3-2-1 backup strategy: hourly NFS backups for fast restores, plus daily cloud backups to Backblaze B2 and Cloudflare R2 for disaster recovery."
date: 2025-12-06
slug: "2025/volsync-kopia-migration"
toc: true
math: false
draft: false
Tags:
  - Volsync
  - Kopia
  - Kubernetes
  - Homelab
  - Backups
  - GitOps
Categories: [Backups, Homelab]
---

> "The best backup strategy is the one you can actually verify and restore from."

## Why Move from Restic to Kopia?

My original Volsync setup used Restic to back up PVCs directly to Backblaze B2. It worked, but had some pain points:

1. **No visibility**: Restic repositories are opaque. You can't browse them without CLI tools.
2. **Slow restores**: Every restore required downloading from S3, which is slow and costs egress fees.
3. **No deduplication across apps**: Each app had its own Restic repository with no shared deduplication.

Kopia solves all of these:

- **Web UI**: Kopia has a built-in web interface to browse snapshots, verify integrity, and trigger restores.
- **Local NFS repository**: Backups go to NFS first (fast restores), then sync to cloud storage.
- **Global deduplication**: A single Kopia repository deduplicates across all PVCs.

The pattern I'm following comes from the [home-operations](https://github.com/home-operations) community—specifically Devin (onedr0p), Jory (joryirving), and Kashall's homelab repos.

## Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  App PVC        │────▶│  Volsync        │────▶│  Kopia Server   │
│  (source)       │     │  ReplicationSrc │     │  (NFS backend)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
                                                ┌─────────────────┐
                                                │  NFS Share      │
                                                │  citadel:/mnt/  │
                                                │  VolsyncKopia   │
                                                └─────────────────┘
```

The key insight: Volsync mover pods need access to the NFS share where Kopia stores its repository. Instead of configuring NFS mounts in every ReplicationSource, we use **MutatingAdmissionPolicy** to automatically inject the NFS volume into any pod with specific labels.

## Prerequisites

Before starting, I needed:

1. **NFS share** on my NAS (citadel.internal) at `/mnt/storage0/backups/VolsyncKopia`
2. **1Password item** named `kopia` with a `KOPIA_PASSWORD` field
3. **Kubernetes 1.33+** for MutatingAdmissionPolicy support

## Step 1: Enable MutatingAdmissionPolicy Feature Gate

MutatingAdmissionPolicy is an alpha feature in Kubernetes 1.33. To enable it on Talos, I added a controller patch:

```yaml
# kubernetes/bootstrap/talos/patches/controller/feature-gates.yaml
cluster:
  apiServer:
    extraArgs:
      feature-gates: ImageVolume=true,MutatingAdmissionPolicy=true
      runtime-config: admissionregistration.k8s.io/v1alpha1=true
```

### The v1beta1 vs v1alpha1 Gotcha

My first attempt used `v1beta1` because that's what the documentation suggested. Wrong. Kubernetes 1.33 only supports **v1alpha1**—v1beta1 arrives in Kubernetes 1.34.

After applying the feature gate and seeing the API still wasn't available, I had to:

1. Change `runtime-config` from `v1beta1` to `v1alpha1`
2. Update all MutatingAdmissionPolicy manifests from `v1beta1` to `v1alpha1`
3. Reapply the Talos config to all three nodes

**Lesson learned**: Always verify API versions before implementing:

```bash
kubectl api-resources --api-group=admissionregistration.k8s.io
kubectl api-versions | grep admission
```

### Rolling Out Talos Changes Safely

I applied the changes one node at a time to minimize risk:

```bash
# Dry-run first
talosctl apply-config -n 10.90.3.101 \
  -f clusterconfig/home-kubernetes-stanton-01.yaml --dry-run

# Apply to first node, wait for Ready
talosctl apply-config -n 10.90.3.101 \
  -f clusterconfig/home-kubernetes-stanton-01.yaml
kubectl get nodes -w

# Repeat for remaining nodes
```

## Step 2: Create the MutatingAdmissionPolicy

The policy automatically injects an NFS volume into Volsync mover pods:

```yaml
# kubernetes/apps/storage/volsync/app/mutatingadmissionpolicy.yaml
---
apiVersion: admissionregistration.k8s.io/v1alpha1
kind: MutatingAdmissionPolicy
metadata:
  name: volsync-mover-nfs
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        resources: ["pods"]
        operations: ["CREATE"]
  matchConditions:
    - name: is-volsync-mover
      expression: "has(object.metadata.labels) && 'volsync.backube/mover' in object.metadata.labels"
  mutations:
    - patchType: ApplyConfiguration
      applyConfiguration:
        expression: |
          Object{
            spec: Object.spec{
              volumes: [
                Object{
                  name: "kopia-repository",
                  nfs: Object{
                    server: "citadel.internal",
                    path: "/mnt/storage0/backups/VolsyncKopia"
                  }
                }
              ],
              containers: object.spec.containers.map(c,
                Object{
                  name: c.name,
                  volumeMounts: [
                    Object{
                      name: "kopia-repository",
                      mountPath: "/repository"
                    }
                  ]
                }
              )
            }
          }
```

This policy:
1. Matches any pod with the label `volsync.backube/mover`
2. Injects an NFS volume pointing to the Kopia repository
3. Mounts it at `/repository` in all containers

I also added a jitter policy to prevent all backup jobs from running simultaneously.

## Step 3: Deploy the Kopia Server

The Kopia server provides a Web UI for browsing and managing backups:

```yaml
# kubernetes/apps/storage/kopia/app/helmrelease.yaml
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: kopia
spec:
  chartRef:
    kind: OCIRepository
    name: kopia
  values:
    controllers:
      kopia:
        containers:
          app:
            image:
              repository: ghcr.io/home-operations/kopia
              tag: 0.22.3@sha256:eeebd12fd4b3a9c25b9f711fff32454f62e2d5e2d431ab6806ad21c52f414807
            env:
              KOPIA_WEB_ENABLED: true
              KOPIA_WEB_PORT: &port 80
              TZ: ${TIMEZONE}
            envFrom:
              - secretRef:
                  name: kopia-secret
            command:
              - /bin/sh
              - -c
              - |
                export HOME=/tmp
                export USER=kopia
                # Initialize repository if it doesn't exist
                if ! kopia repository connect filesystem --path=/repository 2>/dev/null; then
                  echo "Initializing new Kopia repository..."
                  kopia repository create filesystem --path=/repository
                fi
                # Start the server (disable CSRF for reverse proxy compatibility)
                exec kopia server start --address=0.0.0.0:80 --without-password --insecure --disable-csrf-token-checks
    defaultPodOptions:
      securityContext:
        runAsNonRoot: true
        runAsUser: 568
        runAsGroup: 568
        fsGroup: 568
        fsGroupChangePolicy: OnRootMismatch
    route:
      app:
        annotations:
          internal-dns.alpha.kubernetes.io/target: internal.${SECRET_DOMAIN}
        hostnames:
          - "{{ .Release.Name }}.${SECRET_DOMAIN}"
        parentRefs:
          - name: internal
            namespace: network
            sectionName: https
    persistence:
      config-file:
        type: configMap
        identifier: config
        globalMounts:
          - path: /config/repository.config
            subPath: repository.config
      repository:
        type: nfs
        server: citadel.internal
        path: /mnt/storage0/backups/VolsyncKopia
        globalMounts:
          - path: /repository
```

### Mistakes I Made

**1. Repository initialization**: My first deployment crashed because the NFS path was empty—no Kopia repository existed. The startup script now auto-initializes if needed.

**2. KOPIA_PASSWORD handling**: I initially tried passing `--password` as a flag, which expects interactive input. The fix: rely on the `KOPIA_PASSWORD` environment variable being read automatically.

**3. HOME and USER environment variables**: The non-root container couldn't determine the current user. Adding `export HOME=/tmp` and `export USER=kopia` fixed the permission errors.

**4. ConfigMap naming**: app-template creates ConfigMaps using the release name (`kopia`), not a custom suffix. I had to change from `name: kopia-config` to `identifier: config` to reference the chart-defined ConfigMap correctly.

**5. CSRF token errors behind reverse proxy**: When accessing the Kopia Web UI through Gateway API, I got "invalid CSRF token" errors flooding the logs. The fix: add `--disable-csrf-token-checks` to the server start command. This is safe for internal services behind a reverse proxy.

**6. Gateway naming conventions**: My first attempt used `envoy-internal` as the gateway name. Wrong—the gateways are just named `internal` and `external` in the `network` namespace. Also forgot the `sectionName: https`.

**7. Missing DNS annotation**: Routes need `internal-dns.alpha.kubernetes.io/target: internal.${SECRET_DOMAIN}` for internal DNS to create records. Without this, the hostname doesn't resolve.

**8. Hardcoded values**: Used `Pacific/Auckland` instead of `${TIMEZONE}` and `kopia.${SECRET_DOMAIN}` instead of `"{{ .Release.Name }}.${SECRET_DOMAIN}}"`. These should use variables for consistency.

**9. Wrong UID/GID**: Initially used `1000` for the security context. The standard in my cluster is `568` for the `apps` user/group. This matters for NFS share permissions.

## Step 4: Create the Volsync Components

To avoid repeating the same configuration across every app, I created reusable Kustomize components. But I went further than just local NFS—I wanted a proper **3-2-1 backup strategy**:

- **3** copies of data (local PVC + NFS + cloud)
- **2** different storage types (Ceph block + NFS + S3)
- **1** offsite copy (cloud)

### The Multi-Destination Architecture

```
kubernetes/components/volsync/
├── kustomization.yaml          # Includes all 3 (most common)
├── nfs-truenas/                # Local NFS - hourly, with restore
│   ├── externalsecret.yaml
│   ├── kustomization.yaml
│   ├── pvc.yaml
│   ├── replicationdestination.yaml
│   └── replicationsource.yaml
├── s3-backblaze/               # Backblaze B2 - daily DR
│   ├── externalsecret.yaml
│   ├── kustomization.yaml
│   └── replicationsource.yaml
└── s3-cloudflare/              # Cloudflare R2 - daily DR
    ├── externalsecret.yaml
    ├── kustomization.yaml
    └── replicationsource.yaml
```

**Key insight**: The cloud components (B2/R2) don't need PVC or ReplicationDestination. Restores happen from local NFS first (faster). Cloud backups are for disaster recovery only.

### The Root Component

The root `kustomization.yaml` includes all three destinations:

```yaml
# kubernetes/components/volsync/kustomization.yaml
---
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component
components:
  - ./nfs-truenas
  - ./s3-backblaze
  - ./s3-cloudflare
```

This means most apps just need:

```yaml
components:
  - ../../../../components/volsync  # Gets all 3 destinations
```

If you only want specific destinations, reference them directly:

```yaml
components:
  - ../../../../components/volsync/nfs-truenas  # Just local NFS
```

### The NFS Component (Primary)

The NFS component has the PVC and ReplicationDestination for restores:

```yaml
# kubernetes/components/volsync/nfs-truenas/externalsecret.yaml
---
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: "${APP}-volsync"
spec:
  secretStoreRef:
    kind: ClusterSecretStore
    name: onepassword-connect
  target:
    name: "${APP}-volsync-secret"
    template:
      data:
        KOPIA_FS_PATH: /repository
        KOPIA_PASSWORD: "{{ .KOPIA_PASSWORD }}"
        KOPIA_REPOSITORY: filesystem:///repository
  dataFrom:
    - extract:
        key: kopia
```

The ReplicationSource backs up hourly:

```yaml
# kubernetes/components/volsync/nfs-truenas/replicationsource.yaml
---
apiVersion: volsync.backube/v1alpha1
kind: ReplicationSource
metadata:
  name: ${APP}
spec:
  sourcePVC: ${VOLSYNC_CLAIM:=${APP}}
  trigger:
    schedule: "0 * * * *"  # Hourly
  kopia:
    compression: zstd-fastest
    copyMethod: Snapshot
    moverSecurityContext:
      runAsUser: ${VOLSYNC_UID:=568}
      runAsGroup: ${VOLSYNC_GID:=568}
      fsGroup: ${VOLSYNC_GID:=568}
    repository: ${APP}-volsync-secret
    retain:
      hourly: 24
      daily: 7
```

### The Cloud Components (Disaster Recovery)

The Backblaze B2 component uses Kopia's S3-compatible backend:

```yaml
# kubernetes/components/volsync/s3-backblaze/externalsecret.yaml
---
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: "${APP}-volsync-b2"
spec:
  secretStoreRef:
    kind: ClusterSecretStore
    name: onepassword-connect
  target:
    name: "${APP}-volsync-b2-secret"
    template:
      data:
        KOPIA_PASSWORD: "{{ .KOPIA_PASSWORD }}"
        KOPIA_S3_BUCKET: "{{ .VOLSYNC_KOPIA_B2_BUCKET }}"
        KOPIA_S3_ENDPOINT: "s3.us-east-005.backblazeb2.com"
        AWS_ACCESS_KEY_ID: "{{ .VOLSYNC_KOPIA_B2_ACCESS_KEY }}"
        AWS_SECRET_ACCESS_KEY: "{{ .VOLSYNC_KOPIA_B2_SECRET_ACCESS_KEY }}"
        KOPIA_REPOSITORY: "s3://{{ .VOLSYNC_KOPIA_B2_BUCKET }}/${APP}/"
  dataFrom:
    - extract:
        key: kopia
    - extract:
        key: backblaze
```

The ReplicationSource backs up daily and keeps 14 days:

```yaml
# kubernetes/components/volsync/s3-backblaze/replicationsource.yaml
---
apiVersion: volsync.backube/v1alpha1
kind: ReplicationSource
metadata:
  name: ${APP}-b2
spec:
  sourcePVC: ${VOLSYNC_CLAIM:=${APP}}
  trigger:
    schedule: "0 0 * * *"  # Daily at midnight
  kopia:
    compression: zstd-fastest
    copyMethod: Snapshot
    moverSecurityContext:
      runAsUser: ${VOLSYNC_UID:=568}
      runAsGroup: ${VOLSYNC_GID:=568}
      fsGroup: ${VOLSYNC_GID:=568}
    repository: ${APP}-volsync-b2-secret
    retain:
      daily: 14
```

Cloudflare R2 follows the same pattern, with the endpoint constructed from the account ID:

```yaml
KOPIA_S3_ENDPOINT: "{{ .CLOUDFLARE_ACCOUNT_ID }}.r2.cloudflarestorage.com"
```

### Why Kopia for Cloud Too?

You might wonder why I didn't stick with Restic for cloud backups. The answer: **Restic lock issues**. Restic repositories can get stuck with stale locks, requiring manual intervention with `restic unlock`. Kopia handles concurrent access better and doesn't have this problem.

The perfectra1n fork of Volsync (`ghcr.io/perfectra1n/volsync`) supports Kopia's S3 backend via environment variables:

- `KOPIA_S3_BUCKET` - bucket name
- `KOPIA_S3_ENDPOINT` - S3-compatible endpoint
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` - credentials
- `KOPIA_REPOSITORY` - full repository URL (`s3://bucket/path/`)

### Another Gotcha: ClusterSecretStore Name

I assumed the ClusterSecretStore was named `onepassword`. It's actually `onepassword-connect`. Always verify existing resource names:

```bash
kubectl get clustersecretstore
```

## Step 5: Migrate an App (The Hard Way)

Migrating an existing app with data turned out to be more complex than expected. The Kopia volsync component expects PVCs named `${APP}` (e.g., `romm`), but my existing app used `romm-data`. Here's the approach that worked:

### The Problem: PVC Name Mismatch

My romm app used a PVC named `romm-data`, but the volsync component creates resources expecting PVC name `${APP}` (romm). I tried several approaches that failed:

1. **Using VOLSYNC_CLAIM variable** - The component's PVC template still created a conflicting `romm` PVC
2. **Patching the dataSourceRef** - PVC specs are immutable after creation
3. **Snapshotting a terminating PVC** - Can't add finalizers to a PVC marked for deletion

### The Approach That Worked

**Step 1: Keep existing backups running**

Don't switch to Kopia immediately. Keep the old Restic-based volsync template running so you have cloud backups.

**Step 2: Rename the PVC via snapshot**

```bash
# Scale down the app
flux suspend kustomization romm -n games
kubectl scale deploy romm -n games --replicas=0

# Create a snapshot of the existing PVC
kubectl apply -f - <<EOF
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: romm-data-migration
  namespace: games
spec:
  volumeSnapshotClassName: csi-ceph-block
  source:
    persistentVolumeClaimName: romm-data
EOF

# Wait for snapshot to be ready
kubectl get volumesnapshot romm-data-migration -n games

# Create new PVC with correct name from snapshot
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: romm
  namespace: games
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: ceph-block
  dataSource:
    name: romm-data-migration
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  resources:
    requests:
      storage: 5Gi
EOF
```

**Step 3: Update HelmRelease to use new PVC name**

```yaml
# kubernetes/apps/games/romm/app/helmrelease.yaml
persistence:
  data:
    existingClaim: romm  # Changed from romm-data
```

**Step 4: Delete old PVC and resume**

```bash
kubectl delete pvc romm-data -n games
kubectl delete volumesnapshot romm-data-migration -n games
flux resume kustomization romm -n games
```

### The Gotcha: Conflicting dataSourceRef

After the PVC migration, Flux complained about a dry-run failure. The manually-created PVC had `dataSource: VolumeSnapshot`, but the volsync template wanted `dataSourceRef: ReplicationDestination`. These are immutable.

The fix: delete the PVC and let the volsync template recreate it from a cloud restore:

```bash
flux suspend kustomization romm -n games
kubectl scale deploy romm -n games --replicas=0
kubectl delete pvc romm -n games
flux resume kustomization romm -n games
# The ReplicationDestination triggers a restore from R2
```

This works because we kept the Restic backups running throughout the migration.

## Lessons Learned

This migration surfaced several bad assumptions:

| Assumption | Reality | Impact |
|------------|---------|--------|
| MutatingAdmissionPolicy feature gate "just works" | Requires Talos patch for apiServer extraArgs + runtime-config | Had to create patch, regenerate configs, roll out to all nodes |
| K8s 1.33 uses MutatingAdmissionPolicy v1beta1 | Uses **v1alpha1** (v1beta1 is K8s 1.34+) | API server crash, had to fix and reapply |
| ClusterSecretStore named `onepassword` | Named `onepassword-connect` | ExternalSecrets failed to sync |
| app-template creates ConfigMap as `kopia-config` | Creates as `kopia` | Pod stuck in ContainerCreating |
| Kopia repository pre-exists | NFS path was empty | Kopia server crashed on startup |
| Reference patterns from docs were tested | They were aspirational | Multiple fixes needed |
| Can rename PVC by creating new one from snapshot | Works, but dataSource is immutable | Had to delete and restore from cloud |
| PVC dataSourceRef can be patched | PVC spec is immutable after creation | Kustomization dry-run failures |
| VolumeSnapshotClass named `csi-ceph-blockpool` | Named `csi-ceph-block` | Snapshots failed to create |
| Gateway named `envoy-internal` | Named `internal` (in `network` namespace) | HTTPRoute not attached to gateway |
| Routes auto-create DNS records | Need `internal-dns.alpha.kubernetes.io/target` annotation | Hostname didn't resolve |
| Kopia Web UI works behind reverse proxy | CSRF token validation fails | Had to add `--disable-csrf-token-checks` |
| Default UID 1000 is fine | Should use 568 to match NFS share permissions | Permission issues on NFS |
| Can use hardcoded timezone | Should use `${TIMEZONE}` variable | Inconsistent with cluster conventions |

### Verification Commands

Before implementing, always check:

```bash
# API version support
kubectl api-resources | grep -i mutating

# Existing resource names
kubectl get clustersecretstore
kubectl get volumesnapshotclass
kubectl get storageclass
kubectl get gateway -n network

# Chart-generated resources
helm template <release> | grep -i configmap

# After migration, verify backup works
kubectl get replicationsource <app> -n <namespace>
kubectl exec -n storage deployment/kopia -- kopia snapshot list --all
```

## Step 6: The Successful Migration

After fixing all the issues, migrating romm to Kopia was straightforward:

**1. Update the Kustomization to use the component:**

```yaml
# kubernetes/apps/games/romm/app/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ./externalsecret.yaml
  - ./helmrelease.yaml
  - ../../../../templates/gatus/external
components:
  - ../../../../components/volsync  # All 3 destinations: NFS + B2 + R2
```

**2. Set the required variables in ks.yaml:**

```yaml
# kubernetes/apps/games/romm/ks.yaml
postBuild:
  substitute:
    APP: romm
    VOLSYNC_CAPACITY: 5Gi
```

That's it! The `VOLSYNC_UID` and `VOLSYNC_GID` default to `568`, which matches most apps. You only need to specify them if your app uses a different UID/GID:

```yaml
# Only if your app uses a non-standard UID/GID
postBuild:
  substitute:
    APP: myapp
    VOLSYNC_CAPACITY: 10Gi
    VOLSYNC_UID: "1000"  # Override the default 568
    VOLSYNC_GID: "1000"
```

**3. Commit, push, and reconcile:**

```bash
git add . && git commit -m "feat(romm): switch volsync from Restic to Kopia"
git push
flux reconcile kustomization romm -n games
```

**4. Verify the backups:**

```bash
# Check all three ReplicationSources were created
kubectl get replicationsource -n games
# NAME       SOURCE   LAST SYNC              DURATION   NEXT SYNC
# romm       romm     2025-12-06T00:39:46Z   3s         2025-12-06T01:00:00Z
# romm-b2    romm     2025-12-06T00:00:00Z   45s        2025-12-07T00:00:00Z
# romm-r2    romm     2025-12-06T00:00:00Z   48s        2025-12-07T00:00:00Z

# Check snapshots in Kopia Web UI or via CLI
kubectl exec -n storage deployment/kopia -- kopia snapshot list --all
# romm@games:/data
#   2025-12-06 13:39:46 NZDT k... 156.3 MB files:5582 dirs:285
```

The local NFS backup completed in 3 seconds because Kopia's deduplication recognized the existing data. Cloud backups take longer but run daily for disaster recovery.

## Understanding Kopia's Storage

When I first looked at the NFS share after the migration, I was confused:

```
VolsyncKopia ls -la
drwxrwx--- 28 apps apps   32 Dec  6 13:35 .
-rwxrwx---  1 apps apps   43 Dec  6 08:07 .shards
drwxrwx---  3 apps apps    3 Dec  6 08:30 _lo
-rwxrwx---  1 apps apps   30 Dec  6 08:17 kopia.blobcfg.f
-rwxrwx---  1 apps apps 1117 Dec  6 12:31 kopia.maintenance.f
-rwxrwx---  1 apps apps 1101 Dec  6 08:17 kopia.repository.f
drwxrwx---  3 apps apps    3 Dec  6 12:31 p03
drwxrwx---  3 apps apps    3 Dec  6 12:31 p1e
drwxrwx---  3 apps apps    3 Dec  6 12:31 q10
...
```

Where's the `romm` folder? This is **content-addressable storage** - Kopia doesn't store data by source name. Instead:

- Data is deduplicated and compressed into **pack blobs** (the `p*`, `q*`, `s*` folders)
- Blob names are based on content hashes, not source names
- All apps share the same deduplication pool
- To see the logical structure, use `kopia snapshot list --all` or the Web UI

This means if romm and another app have identical files, they're only stored once. The tradeoff is you can't browse the repository directly on the NAS - you need Kopia tools.

**Important**: Never manually delete files from the repository. Kopia uses garbage collection during maintenance to clean up unreferenced blobs safely.

## What's Next

The Kopia infrastructure is deployed and working. Romm is now successfully backing up to all three destinations:

- **NFS (hourly)** - Fast local restores
- **Backblaze B2 (daily)** - Off-site disaster recovery
- **Cloudflare R2 (daily)** - Additional cloud redundancy

The next steps:

1. ~~**romm** (games) - Migrated to Kopia~~ Done!
2. **Downloads namespace** - qbittorrent, radarr, sonarr, etc.
3. **Entertainment namespace** - plex, jellyfin, tautulli
4. **Home automation** - home-assistant, zigbee2mqtt

The key lesson: **keep existing backups running** during migration. Don't switch to the new backup system until you've verified the PVC naming is correct and the app is stable. Having cloud backups as a safety net saved me from data loss multiple times during this migration.

## Summary

| Component | Purpose |
|-----------|---------|
| MutatingAdmissionPolicy | Auto-inject NFS volume into Volsync mover pods |
| Kopia server | Web UI for browsing/managing NFS backups |
| `components/volsync` | Root component that includes all 3 destinations |
| `components/volsync/nfs-truenas` | Primary backup (hourly) with restore capability |
| `components/volsync/s3-backblaze` | Disaster recovery to B2 (daily) |
| `components/volsync/s3-cloudflare` | Disaster recovery to R2 (daily) |

The migration from Restic to Kopia took longer than expected due to API version mismatches and incorrect assumptions about resource names. But the end result—a 3-2-1 backup strategy with local NFS for fast restores and dual cloud destinations for disaster recovery—is worth the effort. No more Restic lock issues!

---

*This post documents part of the ongoing work on my [home-ops](https://github.com/gavinmcfall/home-ops) repository. The patterns here are adapted from the excellent [home-operations](https://github.com/home-operations) community repos.*
