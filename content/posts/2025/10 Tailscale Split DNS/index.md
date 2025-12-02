---
title: "Killing 23 Tailscale Proxies with Split DNS"
description: "How I replaced per-app Tailscale ingresses with a single Connector and Split DNS for same-URL-everywhere remote access"
date: 2025-12-02
slug: "2025/tailscale-split-dns"
toc: true
math: false
draft: false
Tags:
  - Tailscale
  - Kubernetes
  - Homelab
  - DNS
  - Networking
Categories: [Networking, Homelab]
---

> "The best infrastructure is the infrastructure you delete."
> — *Me, staring at 23 proxy pods*

## The Problem: Proxy Sprawl

I've been running Tailscale in my homelab for remote access, using the Tailscale Operator's Ingress feature. It works great — you add a `tailscale` ingress class to your app, and the operator spins up a proxy pod that appears in your Tailnet. Access it via MagicDNS (`paperless.${TAILNET_DNS_NAME}`) and you're in.

The problem? I had **23 of these proxy pods**:

```bash
kubectl get pods -n network | grep ts-
ts-filebrowser-l4k64-0                         1/1     Running
ts-homepage-w2j25-0                            1/1     Running
ts-paperless-r892j-0                           1/1     Running
ts-teslamate-wthbr-0                           1/1     Running
# ... many more
```

Each app gets its own Tailscale device, its own WireGuard tunnel, its own memory footprint. And the URLs are ugly — `paperless.${TAILNET_DNS_NAME}` instead of just `paperless.${SECRET_DOMAIN}`.

What I really wanted: type `paperless.${SECRET_DOMAIN}` from anywhere and have it Just Work. On the LAN, on Tailscale, wherever.

## The Goal: Same URL Everywhere

The dream:

| Location | URL | Result |
|----------|-----|--------|
| LAN | `paperless.${SECRET_DOMAIN}` | Resolves to internal gateway, works |
| Tailscale (remote) | `paperless.${SECRET_DOMAIN}` | Resolves to internal gateway via WireGuard, works |
| Public internet | `paperless.${SECRET_DOMAIN}` | No access (internal-only app) |

One URL. Zero extra infrastructure. No per-app proxy pods.

## The Solution: Split DNS + Connector

The key insight: my internal gateway (`10.90.3.202`) is already reachable via Tailscale — I just need DNS queries to return that IP when I'm connected to the Tailnet.

This requires two pieces:

1. **Tailscale Connector** — A pod that advertises my cluster subnet (`10.90.0.0/16`) to the Tailnet
2. **Split DNS** — Configure Tailscale to forward `*.${SECRET_DOMAIN}` queries to my k8s-gateway

### How It Works

```
Remote Device (Tailscale connected)
    │
    │ 1. Browser: paperless.${SECRET_DOMAIN}
    │ 2. OS DNS query
    ▼
┌─────────────────┐
│ Tailscale Client│  3. Intercepts DNS (Split DNS configured)
│                 │     for *.${SECRET_DOMAIN}
└────────┬────────┘
         │
         │ 4. Forward DNS query via WireGuard tunnel
         ▼
┌─────────────────┐
│   k8s-gateway   │  5. Resolves paperless.${SECRET_DOMAIN}
│   10.90.3.200   │     Returns: 10.90.3.202 (internal gateway)
└────────┬────────┘
         │
         │ 6. Response travels back via WireGuard
         ▼
┌─────────────────┐
│ Tailscale Client│  7. Browser now knows IP: 10.90.3.202
└────────┬────────┘
         │
         │ 8. HTTPS request to 10.90.3.202 via WireGuard
         ▼
┌─────────────────┐
│ Internal Gateway│  9. Matches HTTPRoute, serves request
│   10.90.3.202   │
└─────────────────┘
```

The beauty: my internal gateway doesn't know or care whether the request came from the LAN or through Tailscale. It's just another client hitting `10.90.3.202`.

## Setting Up the Connector

First, I needed a subnet router so Tailscale clients can reach my cluster IPs. The Tailscale Operator makes this easy with the `Connector` CRD:

```yaml
# kubernetes/apps/network/tailscale/operator/app/connector.yaml
---
apiVersion: tailscale.com/v1alpha1
kind: Connector
metadata:
  name: home-subnet
spec:
  hostname: home-subnet-router
  subnetRouter:
    advertiseRoutes:
      - 10.90.0.0/16
```

Add it to your kustomization and push:

```yaml
# kubernetes/apps/network/tailscale/operator/app/kustomization.yaml
---
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ./externalsecret.yaml
  - ./helmrelease.yaml
  - ./connector.yaml
```

After Flux reconciles, you'll see a new pod and Tailscale device:

```bash
kubectl get connector -n network
NAME          SUBNETROUTES   STATUS             AGE
home-subnet   10.90.0.0/16   ConnectorCreated   5m
```

{{< notice warning >}}
You need to approve the subnet routes in Tailscale Admin. Go to [Machines](https://login.tailscale.com/admin/machines), find `home-subnet-router`, and approve the `10.90.0.0/16` route.
{{< /notice >}}

## Configuring Tailscale Split DNS

Now the fun part. In the [Tailscale Admin Console](https://login.tailscale.com/admin/dns):

1. Navigate to the **DNS** tab
2. Under **Nameservers**, click **Add nameserver** → **Custom...**
3. Configure:
   - **Nameserver**: `10.90.3.200` (your k8s-gateway)
   - Check **Restrict to domain**
   - **Domain**: `${SECRET_DOMAIN}`

The dialog looks like this:

```
┌─────────────────────────────────────────────────────────────────┐
│  Add nameserver                                           [x]   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Nameserver                                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 10.90.3.200                                             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ☑ Restrict to domain                                          │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ ${SECRET_DOMAIN}                                             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  This nameserver will only be used for DNS queries matching    │
│  *.${SECRET_DOMAIN}                                                 │
│                                                                 │
│                                        [Cancel]  [Save]         │
└─────────────────────────────────────────────────────────────────┘
```

I also enabled **Override local DNS** to ensure Tailscale's DNS config takes precedence when connected.

## Testing It Works

From a Tailscale-connected device (away from home):

```bash
# Check DNS resolution
dig paperless.${SECRET_DOMAIN}

# Expected:
# paperless.${SECRET_DOMAIN}.    0    IN    A    10.90.3.202
```

From LAN (without Tailscale):

```bash
dig paperless.${SECRET_DOMAIN}

# Expected (via UDM internal DNS):
# paperless.${SECRET_DOMAIN}.    0    IN    A    10.90.3.202
```

Both return the same IP — my internal gateway. Same URL, same destination, regardless of where I am.

## The Migration: Removing Tailscale Ingresses

With Split DNS working, those 23 proxy pods became redundant. Time to delete them.

**Before** (per-app Tailscale proxy):
```yaml
# Each app had this
ingress:
  tailscale:
    enabled: true
    className: tailscale
    hosts:
      - host: paperless  # MagicDNS name only
```

**After** (just the internal route):
```yaml
# Same internal route serves both LAN and Tailscale
route:
  app:
    annotations:
      internal-dns.alpha.kubernetes.io/target: internal.${SECRET_DOMAIN}
    hostnames:
      - paperless.${SECRET_DOMAIN}
    parentRefs:
      - name: internal
        namespace: network

# No ingress.tailscale block!
```

The migration is straightforward:

1. Configure Split DNS in Tailscale admin (done above)
2. Verify access works via `paperless.${SECRET_DOMAIN}` on Tailscale
3. Remove the `ingress.tailscale` blocks from HelmReleases
4. Clean up orphaned Tailscale devices in admin console

## The Numbers

| Metric | Before (Ingress) | After (Split DNS) |
|--------|------------------|-------------------|
| Tailscale proxy pods | 23 | 0 |
| Tailscale devices | 24 (proxies + connector) | 1 (connector) |
| New infrastructure | - | 1 Connector pod |
| URLs to remember | 23 MagicDNS names | 0 (same as LAN) |

## Why This Works

Tailscale's Split DNS feature intercepts DNS queries at the OS level. When I look up `paperless.${SECRET_DOMAIN}`:

1. **On LAN**: Query goes to my UDM Pro, which has internal DNS records pointing to `10.90.3.202`
2. **On Tailscale**: Query is intercepted and forwarded through the WireGuard tunnel to `10.90.3.200` (k8s-gateway), which returns `10.90.3.202`

In both cases, the browser gets `10.90.3.202`. The subsequent HTTPS request goes directly to the internal gateway — on LAN via the local network, on Tailscale via the WireGuard mesh.

The Connector's subnet advertisement is what makes `10.90.3.202` reachable from Tailscale. Without it, DNS would resolve correctly but the connection would timeout.

## Lessons Learned

1. **Split DNS is the right pattern** — Per-app proxies were solving the wrong problem. I didn't need 23 WireGuard tunnels; I needed one subnet route and proper DNS.

2. **Connectors are underrated** — The Tailscale Operator's Connector CRD is incredibly simple. One YAML file, and suddenly your entire cluster subnet is on your Tailnet.

3. **Same URL everywhere matters** — Having to remember `paperless.${TAILNET_DNS_NAME}` vs `paperless.${SECRET_DOMAIN}` was annoying. Now I just use the real URL regardless of where I am.

4. **Delete infrastructure when you can** — Those 23 proxy pods weren't free. They consumed memory, created noise in `kubectl get pods`, and cluttered my Tailscale device list. Sometimes the best optimization is removal.

---

## References

- [Tailscale DNS Documentation](https://tailscale.com/kb/1054/dns) — Official Split DNS guide
- [What is Split DNS?](https://tailscale.com/learn/why-split-dns) — Conceptual overview
- [Tailscale Subnet Routers](https://tailscale.com/kb/1019/subnets) — Making internal networks reachable
- [Tailscale Kubernetes Operator](https://tailscale.com/kb/1236/kubernetes-operator) — Connector CRD docs
