---
title: "Self-Hosting Kubernetes CRD Schemas"
description: "Why I deployed a self-hosted GitHub Actions runner and Cloudflare Pages to serve JSON schemas extracted from my cluster's CRDs, eliminating dependency on third-party schema hosts."
date: 2025-12-13
slug: "2025/self-hosted-kubernetes-schemas"
toc: true
math: false
draft: false
Tags:
  - Kubernetes
  - Homelab
  - GitOps
  - GitHub Actions
  - Cloudflare
  - YAML
Categories: [Kubernetes, Homelab]
---

> "Your IDE's schema validation is only as reliable as the endpoint serving it."

## The Problem: Schema Sprawl

When I audited the `yaml-language-server` schema references across my home-ops repository, I found chaos:

```bash
$ grep -rh "yaml-language-server.*\$schema=" --include="*.yaml" | \
    sed 's/.*\$schema=//' | sort | uniq -c | sort -rn | head -10
    148 https://json.schemastore.org/kustomization
     79 https://kubernetes-schemas.pages.dev/...
     49 https://kubernetes-schemas.pages.dev/...
     21 https://lds-schemas.pages.dev/...
      7 https://kubernetes-schemas.ok8.sh/...
      5 https://kube-schemas.pages.dev/...
      2 https://cluster-schemas.pages.dev/...
```

678 YAML files with schemas, pulling from **six different sources**. All external. All outside my control.

The problems:

1. **Reliability**: If any of these pages.dev sites go down, my IDE validation breaks
2. **Consistency**: Different sources have slightly different schema versions
3. **Staleness**: External schemas might not match my actual cluster CRDs
4. **Version drift**: After upgrading a CRD, schemas lag until someone updates them

The solution: extract schemas directly from my cluster and host them myself.

## The Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Talos Cluster  │────▶│  GitHub Actions │────▶│  Cloudflare     │
│  CRDs           │     │  Runner (self-  │     │  Pages          │
│                 │     │  hosted)        │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
   kubectl get crds      crd-extractor.sh       kubernetes-schemas
   (from cluster)        (JSON conversion)       .nerdz.cloud
```

The workflow:
1. Self-hosted runner has `kubectl` access to the cluster
2. Daily cron job extracts all CRDs and converts to JSON Schema
3. Schemas deploy to Cloudflare Pages at `kubernetes-schemas.nerdz.cloud`
4. All YAML files reference the self-hosted endpoint

## Step 1: GitHub App for Actions Runner Controller

The self-hosted runner needs to authenticate to GitHub. Following the [onedr0p pattern](https://github.com/onedr0p/home-ops), I created a GitHub App rather than using a PAT.

### Creating the App

1. Go to **GitHub Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**
2. Configure:
   - **Name**: `Nerdz-Action Runner`
   - **Homepage URL**: Your repo URL
   - **Webhook**: Disable (unchecked)
   - **Permissions**:
     - Repository: Administration (Read and write), Metadata (Read-only)
   - **Where can this app be installed?**: Only on this account

3. After creation, note the **App ID**
4. Generate a **Private Key** (downloads a .pem file)
5. Install the app on your repository and note the **Installation ID** (from the URL)

### Storing Credentials in 1Password

The private key is multi-line PEM, which 1Password doesn't handle well in text fields. The workaround: base64 encode it.

```powershell
# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("path\to\private-key.pem"))
```

Store in 1Password under a `github-bots` item:
- `ACTIONS_RUNNER_APP_ID`: The App ID
- `ACTIONS_RUNNER_INSTALLATION_ID`: The Installation ID
- `ACTIONS_RUNNER_PRIVATE_KEY`: Base64-encoded private key

## Step 2: Deploy Actions Runner Controller

The controller manages ephemeral runner pods that scale based on workflow demand.

### The Controller HelmRelease

```yaml
# kubernetes/apps/actions-runner-system/actions-runner-controller/app/helmrelease.yaml
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: actions-runner-controller
spec:
  chartRef:
    kind: OCIRepository
    name: gha-runner-scale-set-controller
  interval: 1h
  values:
    replicaCount: 1
```

### The Runner Scale Set

Each repository gets its own runner scale set. The key insight: the runner needs `kubectl` access to extract CRDs, so it gets a ServiceAccount with `cluster-admin`.

```yaml
# kubernetes/apps/actions-runner-system/actions-runner-controller/runners/home-ops/helmrelease.yaml
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: &name home-ops-runner
spec:
  chartRef:
    kind: OCIRepository
    name: gha-runner-scale-set
  values:
    githubConfigUrl: https://github.com/gavinmcfall/home-ops
    githubConfigSecret: home-ops-runner-secret
    minRunners: 1
    maxRunners: 3
    containerMode:
      type: kubernetes
      kubernetesModeWorkVolumeClaim:
        accessModes: [ReadWriteOnce]
        storageClassName: openebs-hostpath
        resources:
          requests:
            storage: 25Gi
    controllerServiceAccount:
      name: actions-runner-controller
      namespace: actions-runner-system
    template:
      spec:
        containers:
          - name: runner
            image: ghcr.io/home-operations/actions-runner:2.330.0
            command: [/home/runner/run.sh]
            env:
              - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
                value: "false"
        serviceAccountName: *name
```

### ExternalSecret with Base64 Decode

The private key needs decoding from base64:

```yaml
# kubernetes/apps/actions-runner-system/actions-runner-controller/runners/home-ops/externalsecret.yaml
---
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: home-ops-runner
spec:
  secretStoreRef:
    kind: ClusterSecretStore
    name: onepassword-connect
  target:
    name: home-ops-runner-secret
    template:
      data:
        github_app_id: "{{ .ACTIONS_RUNNER_APP_ID }}"
        github_app_installation_id: "{{ .ACTIONS_RUNNER_INSTALLATION_ID }}"
        github_app_private_key: "{{ .ACTIONS_RUNNER_PRIVATE_KEY | b64dec }}"
  dataFrom:
    - extract:
        key: github-bots
```

The `| b64dec` template function handles the base64 decoding.

### RBAC for kubectl Access

```yaml
# kubernetes/apps/actions-runner-system/actions-runner-controller/runners/home-ops/rbac.yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: home-ops-runner
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: home-ops-runner
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
  - kind: ServiceAccount
    name: home-ops-runner
    namespace: actions-runner-system
```

## Step 3: The Schemas Workflow

The workflow runs daily, extracts CRDs, and deploys to Cloudflare Pages.

```yaml
# .github/workflows/schemas.yaml
---
name: Schemas

on:
  workflow_dispatch:
  schedule:
    - cron: 0 0 * * *
  push:
    branches: [main]
    paths:
      - .github/workflows/schemas.yaml
      - .github/schemas-index.html

jobs:
  main:
    name: Schemas
    runs-on: home-ops-runner
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Install kubectl
        uses: azure/setup-kubectl@v4

      - name: Setup Python
        uses: actions/setup-python@v6
        with:
          python-version: 3.14.x

      - name: Install Python Dependencies
        run: pip install pyyaml

      - name: Run crd-extractor
        run: |
          curl -fsSL https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/Utilities/crd-extractor.sh | bash

      - name: Generate index.html
        run: |
          cd /home/runner/.datree/crdSchemas
          # ... generate browsable index ...

      - name: Publish Schemas
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: /home/runner/.datree/crdSchemas
          command: pages deploy --project-name=kubernetes-schemas --branch main .
```

The [datreeio/CRDs-catalog](https://github.com/datreeio/CRDs-catalog) crd-extractor script handles the heavy lifting:
1. Runs `kubectl get crds -o yaml`
2. Converts OpenAPI v3 schemas to JSON Schema format
3. Organizes by API group (`helm.toolkit.fluxcd.io/`, `external-secrets.io/`, etc.)

## Step 4: Cloudflare Pages Setup

Cloudflare Pages is deprecated in favor of Workers, but still works for static hosting.

1. Create a Pages project named `kubernetes-schemas`
2. Add custom domain `kubernetes-schemas.nerdz.cloud`
3. Add GitHub secrets:
   - `CLOUDFLARE_API_TOKEN` (with Pages:Edit permission)
   - `CLOUDFLARE_ACCOUNT_ID`

The first workflow run populates the site. After that, it updates daily.

### The Index Page

I added a styled index.html that makes the schemas browsable:

```
kubernetes-schemas.nerdz.cloud/
├── index.html                    # Searchable UI
├── helm.toolkit.fluxcd.io/
│   ├── helmrelease_v2.json
│   └── helmrelease_v2beta2.json
├── external-secrets.io/
│   ├── externalsecret_v1.json
│   └── clustersecretstore_v1.json
└── ... 34 API groups total
```

The UI shows stats (API groups, schema count, last update) and lets you search/filter.

## Step 5: Migrate All YAML Files

With schemas hosted, I migrated 357 files:

```bash
# Replace all external schema sources
find kubernetes/ -name "*.yaml" -exec sed -i \
  's|https://kubernetes-schemas.pages.dev/|https://kubernetes-schemas.nerdz.cloud/|g' {} +

find kubernetes/ -name "*.yaml" -exec sed -i \
  's|https://lds-schemas.pages.dev/|https://kubernetes-schemas.nerdz.cloud/|g' {} +

# ... repeat for ok8.sh, kube-schemas.pages.dev, cluster-schemas.pages.dev
```

I also added schemas to ~75 files that were missing them entirely.

### Schema Version Mismatches

After migration, my IDE showed warnings on many files. The cause: schema URLs didn't match apiVersions.

```yaml
# Wrong - schema says v1beta1 but apiVersion is v1
# yaml-language-server: $schema=https://kubernetes-schemas.nerdz.cloud/external-secrets.io/externalsecret_v1beta1.json
apiVersion: external-secrets.io/v1
```

Fixed 60 files with version mismatches:
- `externalsecret_v1beta1` → `externalsecret_v1` (51 files)
- `clustersecretstore_v1beta1` → `clustersecretstore_v1` (1 file)
- `helmrepository_v1beta2` → `helmrepository_v1` (8 files)

## What Didn't Work: Flux Variable Patterns

One schema validation error I couldn't fix cleanly:

```
HTTPRoute unifi is invalid: at '/spec/hostnames/0':
'unifi.${SECRET_DOMAIN}' does not match pattern '^(\*\.)?[a-z0-9]...'
```

The Flux variable `${SECRET_DOMAIN}` gets substituted at reconciliation time, but the schema validator sees the literal string and fails the hostname pattern.

Options considered:
1. **Patch schemas to allow Flux patterns** - Over-permissive, masks real errors
2. **Accept the warnings** - Harmless, Flux still works
3. **Remove schemas from files with variables** - Loses validation

I went with option 2. The warnings are cosmetic—kubeconform passes, Flux reconciles correctly, and the IDE just shows a squiggle on variable-heavy files.

## The End Result

Before:
- 6 different external schema sources
- No control over availability or freshness
- Schema versions lagging behind CRD upgrades

After:
- Single self-hosted endpoint: `kubernetes-schemas.nerdz.cloud`
- Schemas extracted daily from actual cluster CRDs
- Browsable index with search
- Full control over the infrastructure

```bash
$ curl -sI https://kubernetes-schemas.nerdz.cloud/helm.toolkit.fluxcd.io/helmrelease_v2.json
HTTP/2 200
content-type: application/json
```

The schemas update automatically when I upgrade CRDs. No more waiting for upstream schema repos to catch up.

## Costs

- **Cloudflare Pages**: Free tier
- **GitHub Actions**: Free for public repos (self-hosted runner avoids minute limits anyway)
- **Complexity**: One more thing to maintain, but it's fully GitOps-managed

## Summary

| Component | Purpose |
|-----------|---------|
| GitHub App | Authentication for self-hosted runner |
| Actions Runner Controller | Manages ephemeral runner pods |
| home-ops-runner | Runner scale set with kubectl access |
| crd-extractor.sh | Converts CRDs to JSON Schema |
| Cloudflare Pages | Hosts schemas at custom domain |
| schemas-index.html | Browsable UI for schema discovery |

The self-hosted runner pattern enables more than just schemas—any workflow that needs cluster access (integration tests, deployments, monitoring) can now run on infrastructure I control.

---

*This post documents work on my [home-ops](https://github.com/gavinmcfall/home-ops) repository. The runner pattern is adapted from [onedr0p's home-ops](https://github.com/onedr0p/home-ops) and the broader Kubernetes@Home community.*
