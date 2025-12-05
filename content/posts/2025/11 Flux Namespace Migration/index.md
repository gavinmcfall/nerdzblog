---
title: "Migrating Flux Kustomizations Out of flux-system"
description: "Why I moved every Flux Kustomization into its target namespace, the challenges with substituteFrom, and how strategic patching made it work."
date: 2025-12-05
slug: "2025/flux-namespace-migration"
toc: true
math: false
draft: false
Tags:
  - Flux
  - Kubernetes
  - Homelab
  - GitOps
  - Kustomize
Categories: [Flux, Homelab]
---

> "When your Kustomizations all live in flux-system, cross-namespace dependencies become a tangled mess of implicit assumptions."

## The Problem with Everything in flux-system

If you've run a Flux-managed Kubernetes cluster for any length of time, you've probably inherited (or created) the pattern where every Flux `Kustomization` CR lives in the `flux-system` namespace. It looks something like this:

```yaml
# kubernetes/apps/database/mosquitto/ks.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: mosquitto
  namespace: flux-system  # Everything lives here
spec:
  targetNamespace: database  # But deploys resources here
  dependsOn:
    - name: external-secrets-stores  # No namespace needed - it's also in flux-system
  path: ./kubernetes/apps/database/mosquitto/app
  # ...
```

This works, but it has problems:

1. **Hidden coupling**: Every `dependsOn` implicitly assumes the dependency is in `flux-system`. When you read the manifest, you can't tell where resources actually live.

2. **Crowded namespace**: Running `flux get kustomizations` dumps 80+ resources into one list. Finding the one that's failing means scrolling through walls of text.

3. **Namespace isolation is fake**: Your workloads deploy to separate namespaces, but their reconciliation state all lives in one place. RBAC, network policies, and observability tools can't easily scope to "just the database apps."

4. **The `substituteFrom` trap**: Flux's variable substitution pulls ConfigMaps and Secrets from the Kustomization's namespace. If your Kustomization is in `flux-system` but your app namespace has its own secrets, you need explicit cross-namespace references everywhere.

## The Goal: Kustomizations in Their Target Namespaces

The fix is straightforward in principle: move each Flux `Kustomization` into the namespace it actually manages. The result:

```yaml
# kubernetes/apps/database/mosquitto/ks.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: &app mosquitto
  namespace: &namespace database  # Lives where it deploys
spec:
  targetNamespace: *namespace
  dependsOn:
    - name: external-secrets-stores
      namespace: external-secrets  # Explicit cross-namespace reference
  sourceRef:
    kind: GitRepository
    name: flux-system
    namespace: flux-system  # Git source is still in flux-system
  # ...
```

Now `kubectl get kustomizations -n database` shows only database-related reconcilers. Dependencies are explicit. The mental model matches the deployment model.

## The Challenge: substituteFrom and SOPS Decryption

Here's where it gets interesting. Flux Kustomizations support `postBuild.substituteFrom` to inject variables from ConfigMaps and Secrets:

```yaml
spec:
  postBuild:
    substituteFrom:
      - kind: ConfigMap
        name: cluster-settings
      - kind: Secret
        name: cluster-secrets
```

The catch? From the Flux CRD documentation:

> **Name of the values referent. Should reside in the same namespace as the referring resource.**

When your Kustomization is in `flux-system`, it can reference `cluster-settings` and `cluster-secrets` which also live in `flux-system`. Move the Kustomization to `database`, and suddenly it can't find those ConfigMaps anymore.

The same problem applies to SOPS decryption:

```yaml
spec:
  decryption:
    provider: sops
    secretRef:
      name: sops-age  # Also needs to be in the same namespace
```

You could solve this by copying `cluster-settings`, `cluster-secrets`, and `sops-age` into every namespace. But that defeats the purpose of having cluster-wide settings, and it's a maintenance nightmare.

## The Solution: Strategic Patching from cluster-apps

The elegant solution is to use Flux's patch capability at the parent Kustomization level. In my setup, `cluster-apps` is the top-level Kustomization that reconciles everything under `kubernetes/apps/`:

```yaml
# kubernetes/flux/cluster/ks.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: cluster-apps
  namespace: flux-system
spec:
  path: ./kubernetes/apps
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system
  postBuild:
    substituteFrom:
      - kind: ConfigMap
        name: cluster-settings
      - kind: Secret
        name: cluster-secrets
  patches:
    - patch: |-
        apiVersion: kustomize.toolkit.fluxcd.io/v1
        kind: Kustomization
        metadata:
          name: _
        spec:
          decryption:
            provider: sops
            secretRef:
              name: sops-age
          sourceRef:
            kind: GitRepository
            name: flux-system
            namespace: flux-system
          postBuild:
            substituteFrom:
              - kind: ConfigMap
                name: cluster-settings
                optional: true
              - kind: Secret
                name: cluster-secrets
                optional: true
      target:
        group: kustomize.toolkit.fluxcd.io
        kind: Kustomization
```

This patch is applied to every child Kustomization that `cluster-apps` creates. The key insight: **the patch adds `namespace: flux-system` to the sourceRef and substituteFrom references**, so child Kustomizations can live anywhere while still pulling variables from `flux-system`.

### Breaking Down the Patch

Let's look at what this accomplishes:

1. **`sourceRef.namespace: flux-system`**: Child Kustomizations reference the GitRepository in `flux-system`, regardless of where they live.

2. **`substituteFrom` with `optional: true`**: Variables are pulled from `flux-system`, but if they don't exist, reconciliation continues (useful for namespace-specific overrides).

3. **SOPS decryption**: The `sops-age` secret reference is injected, so encrypted secrets work everywhere.

4. **`name: _`**: This is a patch placeholder - Flux will apply this to all matching resources.

## The Migration Pattern

With the patching in place, migrating each Kustomization follows a consistent pattern:

### Before (in flux-system)

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: mosquitto
  namespace: flux-system
spec:
  targetNamespace: database
  dependsOn:
    - name: dragonfly
  path: ./kubernetes/apps/database/mosquitto/app
  sourceRef:
    kind: GitRepository
    name: flux-system
```

### After (in target namespace)

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: &app mosquitto
  namespace: &namespace database
spec:
  targetNamespace: *namespace
  dependsOn:
    - name: dragonfly
      namespace: database  # Explicit namespace required
  path: ./kubernetes/apps/database/mosquitto/app
  sourceRef:
    kind: GitRepository
    name: flux-system
    namespace: flux-system  # Cross-namespace reference
```

### Key Changes

1. **Add `metadata.namespace`**: Point to the target namespace using a YAML anchor for DRY.

2. **Add `namespace` to `dependsOn`**: Every cross-namespace dependency needs an explicit namespace. Same-namespace dependencies can omit it, but I recommend always including it for clarity.

3. **Add `sourceRef.namespace: flux-system`**: The GitRepository stays in flux-system, so child Kustomizations need to reach across.

## Reusable Components: The Common Pattern

To reduce boilerplate, I created a shared component that every namespace includes:

```yaml
# kubernetes/components/common/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component
resources:
  - ./namespace.yaml
  - ./cluster-vars
  - ./alerts
  - ./sops
```

Each namespace's `kustomization.yaml` pulls this in:

```yaml
# kubernetes/apps/database/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: database

components:
  - ../../components/common

resources:
  - ./cloudnative-pg/ks.yaml
  - ./dragonfly/ks.yaml
  - ./mosquitto/ks.yaml
```

This ensures every namespace gets:
- A properly-labeled Namespace resource
- Cluster-wide variables (ConfigMaps/Secrets)
- Flux alerts and providers
- SOPS external secrets

## Real-World Gotchas

### 1. DNS Resolution During Migration

During my migration, I hit a chicken-and-egg problem. CoreDNS was configured to forward internal DNS to a cluster-internal DNS service, but when that service drifted or wasn't ready, Flux couldn't fetch from Git because DNS was broken.

The fix: simplify DNS architecture. I later removed k8s-gateway entirely and configured CoreDNS to forward to my UDM Pro (`10.90.254.1`), which has DNS records created by external-dns-unifi. This eliminates cluster-internal DNS dependencies during bootstrap.

```yaml
# kubernetes/apps/kube-system/coredns/app/helm-values.yaml
servers:
  - zones:
      - zone: .
    plugins:
      - name: forward
        parameters: . /etc/resolv.conf  # Forwards to UDM (10.90.254.1)
```

### 2. Rook-Ceph and Storage Dependencies

Storage operators like Rook-Ceph are sensitive to manifest changes. Moving Kustomizations around can trigger reconciliation loops that confuse the operator about existing OSDs.

My approach: migrate storage-adjacent namespaces last, and be prepared to wipe and rebuild if Ceph gets confused (see my [Talos DR Reset](/2025/talos-dr-reset) post for that adventure).

### 3. The `cluster-apps-*` Naming Convention

Some apps had legacy names like `cluster-apps-rook-ceph-cluster`. When migrating, I renamed them to just `rook-ceph-cluster`. This meant updating every `dependsOn` that referenced the old name.

A grep through the codebase found all the references:

```bash
grep -r "cluster-apps-" kubernetes/apps/ --include="*.yaml"
```

## Validation

After migrating each namespace, I validated with:

```bash
# Check all Kustomizations in the namespace are Ready
flux get kustomizations -n database

# Force reconcile to ensure no cached state
flux reconcile kustomization mosquitto -n database --force

# Verify HelmReleases deployed correctly
flux get helmreleases -n database
```

For apps that weren't deployed yet (commented out in kustomization.yaml), I verified the YAML was syntactically correct:

```bash
kustomize build kubernetes/apps/cortex --load-restrictor=LoadRestrictionsNone
```

## The End Result

After migrating all namespaces, my cluster has:

- **Clear namespace boundaries**: `kubectl get kustomizations -n downloads` shows only download-related apps
- **Explicit dependencies**: No more guessing where a dependency lives
- **Scoped observability**: Prometheus can scrape per-namespace, dashboards can filter by namespace
- **Simpler RBAC**: Namespace-scoped roles can manage their own Flux resources

The `cluster-apps` parent Kustomization still lives in `flux-system` (it has to - it's the entry point), but everything it spawns now lives where it belongs.

## Summary

| Aspect | Before | After |
|--------|--------|-------|
| Kustomization location | All in `flux-system` | Each in target namespace |
| dependsOn references | Implicit (same namespace) | Explicit with namespace |
| sourceRef | Implicit (same namespace) | Explicit `namespace: flux-system` |
| substituteFrom | Direct reference | Patched from parent with `namespace: flux-system` |
| Observability | One giant list | Namespaced views |

The migration took several sessions and touched 200+ files, but the result is a cleaner, more maintainable GitOps structure. If you're running a homelab with Flux, I highly recommend making this change before your cluster grows any larger.

---

*This post documents the migration I performed on my [home-ops](https://github.com/gavinmcfall/home-ops) repository. The patterns here are heavily inspired by [Kashalls' homelab repo](https://github.com/kashalls/home-ops) and the broader Kubernetes@Home community.*
