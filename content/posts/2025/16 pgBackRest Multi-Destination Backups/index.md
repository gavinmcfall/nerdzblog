---
title: "pgBackRest: Multi-Destination PostgreSQL Backups in CloudNativePG"
description: "How I replaced Barman Cloud Plugin with pgBackRest to get true dual-destination full backups to both Backblaze B2 and Cloudflare R2, then migrated my entire PostgreSQL infrastructure to PostgreSQL 18."
date: 2025-12-19
slug: "2025/pgbackrest-multi-destination-backups"
toc: true
math: false
draft: false
Tags:
  - PostgreSQL
  - CloudNativePG
  - Kubernetes
  - Homelab
  - Backups
  - pgBackRest
Categories: [Database, Backups, Homelab]
---

> "The backup that only exists in one place doesn't exist at all."

## The Problem: Barman's Dirty Secret

I had what I thought was a solid PostgreSQL backup strategy for my Immich database. CloudNativePG with Barman Cloud Plugin, two ObjectStores configured—one for Backblaze B2, one for Cloudflare R2. Daily ScheduledBackups for each destination. Belt and suspenders.

Then I checked the actual buckets.

**B2**: Full backups, WAL files, everything present.
**R2**: Empty. Nothing. Not a single file.

Both ScheduledBackups were writing to B2. The R2 ObjectStore was configured, referenced in the ScheduledBackup—and completely ignored.

Turns out, Barman Cloud Plugin has a limitation I hadn't spotted. The `barmanObjectName` parameter in ScheduledBackup? [It's ignored](https://github.com/cloudnative-pg/plugin-barman-cloud/issues/611). The plugin only uses whatever's configured in the cluster's plugin configuration. Both my scheduled backups were hitting the same destination.

This isn't theoretical concern. If Backblaze goes down, I can't copy backups to R2 because they're only in B2. My 3-2-1 backup strategy was actually a 2-1-1.

## The Alternative: pgBackRest

After researching alternatives, I found three options for PostgreSQL backups with CloudNativePG plugins:

1. **Barman** (what I was using) - Single destination limitation
2. **WAL-G** - Similar architecture, no multi-repo support
3. **pgBackRest** - Native multi-repository support

pgBackRest from [Dalibo](https://github.com/dalibo/cnpg-plugin-pgbackrest) looked promising. It's designed from the ground up for multi-repository backups—WAL archiving goes to ALL configured repositories simultaneously. The catch: it's experimental, has 16 GitHub stars, and the documentation is thin.

I gave it a shot anyway.

## Deploying the pgBackRest Plugin

Unlike Barman which has a Helm chart, the Dalibo pgBackRest plugin requires manual deployment. I created a new directory structure:

```
kubernetes/apps/database/cloudnative-pg/pgbackrest/
├── kustomization.yaml
├── crd.yaml          # Repository CRD
├── rbac.yaml         # ServiceAccount, ClusterRole, RoleBinding
├── certificate.yaml  # Self-signed TLS for plugin communication
├── deployment.yaml   # The controller
└── service.yaml      # Exposes the controller to CNPG
```

The controller deployment is straightforward:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pgbackrest-controller
  namespace: database
spec:
  replicas: 1
  selector:
    matchLabels:
      app: pgbackrest-controller
  template:
    spec:
      containers:
        - name: pgbackrest-controller
          image: registry.hub.docker.com/dalibo/cnpg-pgbackrest-controller:latest
          args:
            - operator
            - --server-cert=/server/tls.crt
            - --server-key=/server/tls.key
            - --client-cert=/client/tls.crt
            - --server-address=:9090
            - --log-level=debug
          env:
            - name: SIDECAR_IMAGE
              value: registry.hub.docker.com/dalibo/cnpg-pgbackrest-sidecar:latest
          volumeMounts:
            - mountPath: /server
              name: server
            - mountPath: /client
              name: client
      volumes:
        - name: server
          secret:
            secretName: pgbackrest-controller-server-tls
        - name: client
          secret:
            secretName: pgbackrest-controller-client-tls
```

### The Service Name Gotcha

My first deployment crashed with a cryptic error:

```
stanza creation failed: can't parse pgbackrest JSON: invalid character 'P'
```

After way too much debugging, I found the issue. I'd named the service `pgbackrest`. Kubernetes automatically creates environment variables for services: `PGBACKREST_SERVICE_HOST`, `PGBACKREST_PORT`, etc.

pgBackRest interprets **any** `PGBACKREST_*` environment variable as configuration. The sidecar was trying to parse `PGBACKREST_PORT_9090_TCP_ADDR` as a pgBackRest option and choking on the JSON output.

The fix: rename the service to `cnpg-pgbackrest`. No more environment variable conflicts.

### Leader Lease Conflict

After fixing the service name, the controller was stuck:

```
attempting to acquire leader lease database/822e3f5c.cnpg.io...
```

Both Barman and pgBackRest plugins use the same leader election lease name. I had to disable Barman first:

```bash
flux suspend helmrelease barman-cloud -n database
kubectl scale deployment barman-cloud-plugin-barman-cloud -n database --replicas=0
```

Once Barman released the lease, pgBackRest acquired it and started working.

## Configuring Multi-Repository Backups

The Repository CR is where the magic happens. You can define multiple S3 repositories and pgBackRest will archive WAL to all of them:

```yaml
apiVersion: pgbackrest.dalibo.com/v1
kind: Repository
metadata:
  name: immich18-repository
  namespace: database
spec:
  repoConfiguration:
    stanza: immich18
    archive:
      async: true
      pushQueueMax: 1GiB
    s3Repositories:
      # Primary: Backblaze B2
      - bucket: ${IMMICH_PG_BACKUP_B2_BUCKET}
        endpoint: s3.us-east-005.backblazeb2.com
        region: us-east-005
        repoPath: /immich18
        retentionPolicy:
          full: 14
          fullType: count
        secretRef:
          accessKeyId:
            name: immich-cnpg-secret
            key: b2-access-key-id
          secretAccessKey:
            name: immich-cnpg-secret
            key: b2-secret-access-key
      # Secondary: Cloudflare R2 (use Flux variable substitution)
      - bucket: ${IMMICH_PG_BACKUP_R2_BUCKET}
        endpoint: ${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com
        region: auto
        repoPath: /immich18
        retentionPolicy:
          full: 14
          fullType: count
        secretRef:
          accessKeyId:
            name: immich-cnpg-secret
            key: r2-access-key-id
          secretAccessKey:
            name: immich-cnpg-secret
            key: r2-secret-access-key
```

Note the R2 bucket and endpoint use Flux variable substitution (`${VARIABLE_NAME}`) instead of hardcoded values. These get populated from an ExternalSecret that pulls from 1Password, with the Flux Kustomization configured to substitute variables from that secret. This keeps sensitive values like Cloudflare account IDs out of git history.

The cluster just needs to reference the plugin:

```yaml
spec:
  plugins:
    - name: pgbackrest.dalibo.com
      parameters:
        repositoryRef: immich18-repository
```

## The Backup Target Problem

First backup attempt failed:

```
ERROR: [056]: unable to find primary cluster - cannot proceed
HINT: are all available clusters in recovery?
```

CNPG defaults to running backups on replicas to reduce load on the primary. But pgBackRest can't run backups from replicas without SSH access to the primary—which doesn't exist in Kubernetes.

The fix is simple: tell CNPG to run backups on the primary:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: immich18-daily-b2
spec:
  schedule: "0 3 * * *"
  target: primary  # This is the key
  method: plugin
  cluster:
    name: immich18
  pluginConfiguration:
    name: pgbackrest.dalibo.com
```

## The Multi-Repo Full Backup Discovery

With the target fixed, backups started working. WAL archiving was going to both repositories—I could see files appearing in both B2 and R2. But when I checked the full backups:

```bash
# B2
aws s3 ls s3://<your-bucket>/immich18/ --profile backblaze-b2 --recursive | wc -l
1285

# R2
aws s3 ls s3://<your-bucket>/immich18/ --profile cloudflare-r2 --region auto --recursive | wc -l
11
```

WAL archives were in both. Full backup was only in B2.

This is actually intentional behavior in pgBackRest. From the [documentation](https://pgbackrest.org/command.html):

- **WAL archiving**: Pushes to ALL configured repositories simultaneously
- **Full backups**: Only runs against ONE repository (defaults to repo1)

The reasoning makes sense—full backups are large and expensive. Doing them twice doubles storage costs. WAL goes everywhere for redundancy.

But for disaster recovery, I needed full backups in both locations.

### The selectedRepository Parameter

After digging through the [plugin source code](https://github.com/dalibo/cnpg-plugin-pgbackrest/blob/main/internal/instance/backup.go), I found the solution. The plugin accepts a `selectedRepository` parameter:

```go
selectedRepo, ok := request.Parameters["selectedRepository"]
if !ok {
    selectedRepo = "1" // use first repo by default
}
```

Note: the parameter is `selectedRepository`, not `repo`. The code defaults to repository 1 if not specified.

Testing it:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: pgbackrest-r2-test
spec:
  cluster:
    name: immich18
  method: plugin
  target: primary
  pluginConfiguration:
    name: pgbackrest.dalibo.com
    parameters:
      selectedRepository: "2"
```

The logs confirmed it:

```json
{"msg":"using repo","repo":"PGBACKREST_REPO=2"}
```

After waiting for the backup to complete:

```bash
aws s3 ls s3://<your-bucket>/immich18/ --profile cloudflare-r2 --region auto --recursive | wc -l
1232
```

Full backup in R2.

## The Final Configuration: Two ScheduledBackups

To get true dual-destination full backups, I created two ScheduledBackups—one for each repository:

```yaml
---
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: immich18-daily-b2
  namespace: database
spec:
  schedule: "0 3 * * *"
  immediate: true
  backupOwnerReference: self
  method: plugin
  target: primary
  cluster:
    name: immich18
  pluginConfiguration:
    name: pgbackrest.dalibo.com
    parameters:
      selectedRepository: "1"
---
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: immich18-daily-r2
  namespace: database
spec:
  # Offset by 1 hour to avoid concurrent runs
  schedule: "0 4 * * *"
  immediate: false
  backupOwnerReference: self
  method: plugin
  target: primary
  cluster:
    name: immich18
  pluginConfiguration:
    name: pgbackrest.dalibo.com
    parameters:
      selectedRepository: "2"
```

Key details:
- Schedules are offset by 1 hour to avoid concurrent backup operations
- `immediate: true` only on the first one (don't need two immediate backups)
- Both target the primary explicitly

## Verifying the Setup

After deployment, both buckets showed full backups:

| Bucket | Files | Full Backup |
|--------|-------|-------------|
| B2 | 1285+ | `20251217-034103F` |
| R2 | 1232+ | `20251217-035928F` |

WAL archiving continues to push to both repositories automatically. The Repository CR status shows the recovery window:

```yaml
status:
  recoveryWindow:
    firstBackup:
      label: 20251217-034103F
      type: full
    lastBackup:
      label: 20251217-035928F
      type: full
```

## Lessons Learned

| Assumption | Reality | Fix |
|------------|---------|-----|
| Barman supports multiple ObjectStores per ScheduledBackup | `barmanObjectName` is ignored | Switch to pgBackRest |
| Service name `pgbackrest` is fine | Creates conflicting `PGBACKREST_*` env vars | Use `cnpg-pgbackrest` |
| Plugins can share leader leases | They use the same lease name | Disable Barman first |
| Backups run on any cluster member | pgBackRest needs the primary | Add `target: primary` |
| Parameter name is `repo` | It's `selectedRepository` | Read the source code |
| pgBackRest multi-repo means full backups everywhere | WAL yes, full backups no | Create two ScheduledBackups |

## Is pgBackRest Worth It?

For the specific use case of multi-destination full backups, yes. The Dalibo plugin is experimental but functional. The key advantages over Barman:

1. **True WAL replication**: WAL files go to all repositories simultaneously
2. **Explicit repository selection**: You can target specific repos for full backups
3. **Better retention policies**: Per-repository retention configuration

The downsides:
- No Helm chart (manual deployment required)
- Experimental status (16 stars on GitHub)
- Documentation is sparse (I had to read source code)

For a homelab where I'm willing to debug issues, it's the right choice. For production, I'd wait for the plugin to mature or implement external replication (rclone sync between buckets).

## Part 2: The Full Migration

With pgBackRest working for Immich, I decided to go all-in and migrate my entire PostgreSQL infrastructure:

1. **Rename immich18 to postgres18-immich** - Clearer naming convention
2. **Create postgres18-cluster** - New cluster to replace postgres17 (which used Barman)
3. **Migrate all 46 databases** from postgres17 to postgres18-cluster

### Shared Credentials

Rather than managing separate S3 credentials for each cluster, I consolidated to shared pgBackRest credentials:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: cnpg-secret
  namespace: database
spec:
  secretStoreRef:
    kind: ClusterSecretStore
    name: onepassword-connect
  target:
    name: cnpg-secret
  data:
    # pgBackRest B2 - shared across all clusters
    - secretKey: b2-access-key-id
      remoteRef:
        key: backblaze
        property: BACKBLAZE_PGBACKREST_ACCESS_KEY
    - secretKey: b2-secret-access-key
      remoteRef:
        key: backblaze
        property: BACKBLAZE_PGBACKREST_SECRET_ACCESS_KEY
    # pgBackRest R2 - shared across all clusters
    - secretKey: r2-access-key-id
      remoteRef:
        key: cloudflare
        property: CLOUDFLARE_PGBACKREST_ACCESS_KEY
    - secretKey: r2-secret-access-key
      remoteRef:
        key: cloudflare
        property: CLOUDFLARE_PGBACKREST_SECRET_ACCESS_KEY
```

Each cluster gets its own S3 bucket but shares the same credentials, simplifying secret management.

### Creating postgres18-cluster

The new cluster uses standard CloudNativePG PostgreSQL 18 (no VectorChord needed - that's only for Immich):

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgres18-cluster
  namespace: database
spec:
  instances: 3
  imageName: ghcr.io/cloudnative-pg/postgresql:18@sha256:7f374e054e46fdefd64b52904e32362949703a75c05302dca8ffa1eb78d41891
  storage:
    size: 20Gi
    storageClass: openebs-hostpath
  postgresql:
    parameters:
      max_connections: "200"
      shared_buffers: 256MB
      wal_keep_size: 2GB
  plugins:
    - name: pgbackrest.dalibo.com
      parameters:
        repositoryRef: postgres18-cluster-repository
  bootstrap:
    initdb:
      database: postgres
      owner: postgres
```

With its own Repository CR pointing to `nerdz-postgres-cluster` bucket:

```yaml
apiVersion: pgbackrest.dalibo.com/v1
kind: Repository
metadata:
  name: postgres18-cluster-repository
  namespace: database
spec:
  repoConfiguration:
    stanza: postgres18-cluster
    archive:
      async: true
      pushQueueMax: 1GiB
    s3Repositories:
      - bucket: nerdz-postgres-cluster
        endpoint: s3.us-east-005.backblazeb2.com
        region: us-east-005
        repoPath: /postgres18-cluster
        retentionPolicy:
          full: 14
          fullType: count
        secretRef:
          accessKeyId:
            name: cnpg-secret
            key: b2-access-key-id
          secretAccessKey:
            name: cnpg-secret
            key: b2-secret-access-key
      - bucket: nerdz-postgres-cluster
        endpoint: ${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com
        region: auto
        repoPath: /postgres18-cluster
        retentionPolicy:
          full: 14
          fullType: count
        secretRef:
          accessKeyId:
            name: cnpg-secret
            key: r2-access-key-id
          secretAccessKey:
            name: cnpg-secret
            key: r2-secret-access-key
```

### The Migration: pg_dump Direct Pipe

With postgres18-cluster running and healthy, it was time to migrate 46 databases (~1.8GB total) from postgres17.

**Step 1: Scale down all apps**

```bash
# Downloads namespace (14 apps)
kubectl scale deploy -n downloads autobrr bazarr bazarr-foreign bazarr-uhd \
  dashbrr prowlarr radarr radarr-uhd readarr sabnzbd sonarr sonarr-foreign \
  sonarr-uhd whisparr --replicas=0

# Home namespace
kubectl scale deploy -n home atuin linkwarden manyfold paperless --replicas=0

# Home-automation namespace
kubectl scale deploy -n home-automation n8n teslamate --replicas=0

# Other namespaces
kubectl scale deploy -n games romm --replicas=0
kubectl scale deploy -n observability gatus --replicas=0
kubectl scale deploy -n plane plane-admin-wl plane-api-wl plane-beat-worker-wl \
  plane-live-wl plane-space-wl plane-worker-wl --replicas=0
kubectl scale deploy -n security pocket-id --replicas=0
```

**Step 2: Verify no connections**

```bash
kubectl exec -n database postgres17-1 -c postgres -- psql -U postgres -c \
  "SELECT datname, usename, client_addr, state FROM pg_stat_activity \
   WHERE datname IS NOT NULL ORDER BY datname;"
```

Only the query connection itself should appear.

**Step 3: Direct pipe migration**

```bash
kubectl exec -n database postgres17-1 -c postgres -- pg_dumpall -U postgres | \
  kubectl exec -i -n database postgres18-cluster-1 -c postgres -- psql -U postgres
```

This pipes the dump directly between clusters - no intermediate file needed. The only "errors" are expected:

```
ERROR:  role "postgres" already exists
ERROR:  role "streaming_replica" already exists
```

These roles already exist in the target cluster.

**Step 4: Verify the migration**

```bash
# Check database counts match
kubectl exec -n database postgres17-1 -c postgres -- psql -U postgres -c \
  "SELECT COUNT(*) FROM pg_database WHERE datname NOT IN ('template0', 'template1');"
# Result: 46

kubectl exec -n database postgres18-cluster-1 -c postgres -- psql -U postgres -c \
  "SELECT COUNT(*) FROM pg_database WHERE datname NOT IN ('template0', 'template1');"
# Result: 46

# Spot check critical data
kubectl exec -n database postgres18-cluster-1 -c postgres -- psql -U postgres -d teslamate -c \
  "SELECT COUNT(*) FROM positions;"
# Result: 3,140,499 (matches source)
```

**Step 5: Update ExternalSecrets**

All apps needed their database hostname updated from `postgres17-rw.database.svc.cluster.local` to `postgres18-cluster-rw.database.svc.cluster.local`:

```bash
find kubernetes/apps -name "*.yaml" -exec grep -l "postgres17-rw" {} \; | \
  xargs sed -i 's/postgres17-rw\.database\.svc\.cluster\.local/postgres18-cluster-rw.database.svc.cluster.local/g'
```

**Step 6: Scale apps back up**

```bash
kubectl scale deploy -n downloads autobrr bazarr bazarr-foreign bazarr-uhd \
  dashbrr prowlarr radarr radarr-uhd readarr sabnzbd sonarr sonarr-foreign \
  sonarr-uhd whisparr --replicas=1
# ... repeat for other namespaces
```

### Adding PgBouncer Connection Pooling

For better connection management, I added PgBouncer poolers to both clusters:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Pooler
metadata:
  name: postgres18-cluster-pooler
  namespace: database
spec:
  cluster:
    name: postgres18-cluster
  instances: 2
  type: rw
  pgbouncer:
    poolMode: session
    parameters:
      max_client_conn: "500"
      default_pool_size: "100"
```

### Cleanup

With everything migrated and verified:

```bash
# Suspend the old Kustomization
flux suspend kustomization cloudnative-pg-cluster17 -n database

# Delete the cluster
kubectl delete cluster postgres17 -n database

# Remove from git
rm -rf kubernetes/apps/database/cloudnative-pg/cluster17/
# Edit ks.yaml to remove the cluster17 Kustomization
git add -A && git commit -m "chore(database): remove postgres17 cluster"
git push
```

## Final Architecture

```
kubernetes/apps/database/cloudnative-pg/
├── app/                      # CNPG operator + shared secrets
├── pgbackrest/               # pgBackRest controller
├── postgres18-immich/        # Immich cluster (VectorChord)
│   ├── postgres18-immich.yaml
│   ├── repository.yaml       # B2: nerdz-postgres-immich
│   ├── scheduledbackup.yaml  # B2 @ 03:00, R2 @ 04:00
│   ├── pooler.yaml
│   └── service.yaml
└── postgres18-cluster/       # Main cluster (all other apps)
    ├── postgres18-cluster.yaml
    ├── repository.yaml       # B2: nerdz-postgres-cluster
    ├── scheduledbackup.yaml  # B2 @ 03:00, R2 @ 04:00
    ├── pooler.yaml
    └── service.yaml
```

| Cluster | Purpose | Image | Backups |
|---------|---------|-------|---------|
| postgres18-immich | Immich only | VectorChord PG18 | B2 + R2 via pgBackRest |
| postgres18-cluster | All other apps (46 DBs) | Standard PG18 | B2 + R2 via pgBackRest |

## The Complete Lessons Learned

| Assumption | Reality | Fix |
|------------|---------|-----|
| Barman supports multiple ObjectStores per ScheduledBackup | `barmanObjectName` is ignored | Switch to pgBackRest |
| Service name `pgbackrest` is fine | Creates conflicting `PGBACKREST_*` env vars | Use `cnpg-pgbackrest` |
| Plugins can share leader leases | They use the same lease name | Disable Barman first |
| Backups run on any cluster member | pgBackRest needs the primary | Add `target: primary` |
| Parameter name is `repo` | It's `selectedRepository` | Read the source code |
| pgBackRest multi-repo means full backups everywhere | WAL yes, full backups no | Create two ScheduledBackups |
| pg_dumpall needs intermediate storage | Direct pipe works fine | `pg_dumpall \| psql` between pods |
| CNPG clusters can scale to 0 | Minimum is 1 instance | Suspend Kustomization + delete cluster |

## Is It Worth It?

Absolutely. The migration took about 2 hours total:

- **Zero data loss**: All 46 databases migrated with verified row counts
- **Zero downtime** (for the migration itself - apps were briefly stopped)
- **True dual-destination backups**: Both B2 and R2 now have full backups
- **Cleaner architecture**: Shared credentials, consistent naming, PgBouncer pooling
- **PostgreSQL 18**: Latest version with performance improvements

The pgBackRest plugin is experimental, but it works. For a homelab, it's the right choice.

---

*This post documents part of the ongoing work on my [home-ops](https://github.com/gavinmcfall/home-ops) repository. The pgBackRest plugin is from [Dalibo](https://github.com/dalibo/cnpg-plugin-pgbackrest).*
