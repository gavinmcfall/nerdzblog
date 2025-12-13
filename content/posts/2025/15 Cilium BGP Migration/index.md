---
title: "From L2 Announcements to BGP: Migrating Cilium LoadBalancer IPs"
description: "Why I moved from Cilium L2 announcements to BGP for LoadBalancer IP advertisement, and how a dedicated Services VLAN simplified everything."
date: 2025-12-13
slug: "2025/cilium-bgp-migration"
toc: true
math: false
draft: false
Tags:
  - Cilium
  - Kubernetes
  - Homelab
  - Networking
  - BGP
Categories: [Networking, Homelab]
---

> "L2 is fine until it isn't. BGP is harder until it isn't."
> — *Every network engineer eventually*

## The Problem: L2 Announcements on a Crowded Subnet

My homelab has been running Cilium with L2 announcements for LoadBalancer IPs. It works — Cilium responds to ARP requests on behalf of the service IPs, and traffic flows. Simple.

The problem? All my LoadBalancer IPs lived on the same `/24` as my nodes (`10.90.3.0/24`). With nodes, pods, services, and management devices all sharing airspace, I was running out of room. And L2 announcements have limitations:

1. **Subnet constraint**: IPs must be on the same L2 segment as the announcing nodes
2. **ARP storms**: High-traffic services can generate noisy ARP traffic
3. **No route aggregation**: Each IP is independently announced via ARP
4. **Single point of failure**: Only one node responds to ARP for a given IP

I wanted a cleaner architecture: a dedicated Services VLAN for LoadBalancer IPs, advertised via BGP to my UDM Pro.

## The Goal: BGP-Advertised LoadBalancer IPs on a Dedicated VLAN

The target architecture:

| Component | Before | After |
|-----------|--------|-------|
| LoadBalancer IP range | `10.90.3.200-210` (node subnet) | `10.99.8.0/24` (Services VLAN) |
| Advertisement method | L2 (ARP) | BGP |
| Cluster ASN | N/A | 65010 |
| Router ASN | N/A | 65001 (UDM Pro) |

With BGP, the cluster announces routes to my UDM Pro, which installs them in its routing table. Traffic to `10.99.8.x` gets routed to whichever node is advertising that IP — no ARP required.

## How BGP LoadBalancer Advertisement Works

```
                                          ┌─────────────────────────────┐
                                          │         UDM Pro             │
                                          │        ASN 65001            │
                                          │       10.90.254.1           │
                                          └──────────┬──────────────────┘
                                                     │
                    BGP Sessions (eBGP)              │
       ┌─────────────────────────┬──────────────────┼────────────────────┐
       │                         │                  │                    │
       ▼                         ▼                  ▼                    │
┌─────────────┐          ┌─────────────┐    ┌─────────────┐             │
│   Node 1    │          │   Node 2    │    │   Node 3    │             │
│  ASN 65010  │          │  ASN 65010  │    │  ASN 65010  │             │
│ 10.90.3.101 │          │ 10.90.3.102 │    │ 10.90.3.103 │             │
└──────┬──────┘          └──────┬──────┘    └──────┬──────┘             │
       │                        │                  │                    │
       │  Announces:            │  Announces:      │  Announces:        │
       │  10.99.8.201 (envoy)   │  10.99.8.203     │  10.99.8.205       │
       │  10.99.8.207 (dragonfly)│ (mosquitto)     │  (qbittorrent)     │
       └────────────────────────┴──────────────────┴────────────────────┘

When client requests 10.99.8.201:
1. UDM Pro looks up route → next-hop is Node 1
2. Traffic routed directly to Node 1
3. Cilium delivers to envoy-gateway pod
```

The key advantage: BGP routes are L3, so my LoadBalancer IPs can live on any subnet — they don't need to be on the same broadcast domain as the nodes.

## The Migration

### Step 1: Enable BGP Control Plane in Cilium

First, enable the BGP control plane in Cilium's Helm values:

```yaml
# kubernetes/apps/kube-system/cilium/app/helm-values.yaml
bgpControlPlane:
  enabled: true
```

This unlocks the new BGP CRDs but doesn't configure any peering yet.

### Step 2: Create the BGP CRDs

Cilium's BGP implementation uses four CRDs:

```yaml
# kubernetes/apps/kube-system/cilium/app/networking.yaml
---
# What to advertise
apiVersion: cilium.io/v2
kind: CiliumBGPAdvertisement
metadata:
  name: lb-services
  labels:
    advertise: bgp
spec:
  advertisements:
    - advertisementType: "Service"
      service:
        addresses:
          - LoadBalancerIP
      # Advertise all LoadBalancer services unless explicitly excluded
      selector:
        matchExpressions:
          - key: io.cilium/bgp-announce
            operator: NotIn
            values: ["false"]
---
# How to peer (timers, graceful restart)
apiVersion: cilium.io/v2
kind: CiliumBGPPeerConfig
metadata:
  name: udm-peer
spec:
  timers:
    holdTimeSeconds: 90
    keepAliveTimeSeconds: 30
  gracefulRestart:
    enabled: true
    restartTimeSeconds: 120
  families:
    - afi: ipv4
      safi: unicast
      advertisements:
        matchLabels:
          advertise: bgp
---
# Cluster-wide BGP configuration
apiVersion: cilium.io/v2
kind: CiliumBGPClusterConfig
metadata:
  name: bgp-cluster
spec:
  nodeSelector:
    matchLabels:
      kubernetes.io/os: linux
  bgpInstances:
    - name: "home-cluster"
      localASN: 65010
      peers:
        - name: "udm-pro"
          peerAddress: "10.90.254.1"
          peerASN: 65001
          peerConfigRef:
            name: udm-peer
---
# IP pool for LoadBalancer services
apiVersion: cilium.io/v2
kind: CiliumLoadBalancerIPPool
metadata:
  name: lb-pool
spec:
  allowFirstLastIPs: "No"
  blocks:
    - cidr: "10.99.8.0/24"
```

### Step 3: Configure BGP on the UDM Pro

On the UniFi side, I configured BGP in the Network settings:

1. **Enable BGP**: Settings → Routing → BGP
2. **Local ASN**: 65001
3. **Add neighbor**: 10.90.3.101-103 (each node), ASN 65010
4. **Accept routes**: Enable route acceptance from neighbors

The UDM Pro now accepts route announcements from the cluster and installs them in its routing table.

### Step 4: Centralize LoadBalancer IP Variables

Rather than scattering hardcoded IPs across HelmReleases, I centralized them in `cluster-settings.yaml`:

```yaml
# kubernetes/components/common/cluster-vars/cluster-settings.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-settings
data:
  # LoadBalancer IPs (Services VLAN - 10.99.8.0/24)
  ENVOY_EXTERNAL_LBIP: "10.99.8.201"
  ENVOY_INTERNAL_LBIP: "10.99.8.202"
  MOSQUITTO_LBIP: "10.99.8.203"
  SMTP_RELAY_LBIP: "10.99.8.204"
  QBITTORRENT_LBIP: "10.99.8.205"
  PLEX_LBIP: "10.99.8.206"
  DRAGONFLY_LBIP: "10.99.8.207"
  JELLYFIN_LBIP: "10.99.8.208"
  NETWORK_UPS_TOOLS_LBIP: "10.99.8.209"
  GRAPHITE_EXPORTER_LBIP: "10.99.8.210"
  POSTGRES17_LBIP: "10.99.8.211"
```

Services reference these via Flux variable substitution:

```yaml
# Example: dragonfly service
apiVersion: v1
kind: Service
metadata:
  name: dragonfly-lb
  annotations:
    io.cilium/lb-ipam-ips: ${DRAGONFLY_LBIP}
spec:
  type: LoadBalancer
  ports:
    - name: dragonfly
      port: 6379
```

{{< notice info >}}
**Variable naming**: Flux's envsubst doesn't allow hyphens in variable names. Use underscores: `DRAGONFLY_LBIP` not `DRAGONFLY-LBIP`.
{{< /notice >}}

### Step 5: Remove L2 Announcement Configuration

With BGP working, I removed the old L2 configs:

- `CiliumL2AnnouncementPolicy` — deleted
- `CiliumLoadBalancerIPPool` for old subnet — replaced with new `10.99.8.0/24` pool

### Step 6: Update DNS

The internal gateway moved from `10.90.3.202` to `10.99.8.202`. I updated the DNS A record for `internal.nerdz.cloud` in my UDM Pro's local DNS settings (managed via external-dns-unifi, but this specific record needed a manual kick).

## Post-Migration Cleanup

After the BGP migration, some pods had stale network state — they'd cached the old gateway IP or had connection pools pointing to old addresses. The fix was simple: restart everything.

```bash
# Restart all deployments in affected namespaces
for ns in downloads entertainment home home-automation games observability; do
  kubectl rollout restart deployment -n $ns
done
```

I also discovered an interesting side effect: Cilium performs TCP health checks on LoadBalancer services. My mosquitto logs filled with:

```
Client <unknown> closed its connection.
```

These are Cilium's BGP control plane verifying the service is reachable — completely normal, not an error.

## Verifying BGP Sessions

To confirm BGP is working, exec into a Cilium pod and check peer status:

```bash
# Check BGP peering status from each node
kubectl exec -n kube-system ds/cilium -- cilium-dbg bgp peers
```

Output shows all three nodes with established sessions:

```
=== stanton-01 ===
Local AS   Peer AS   Peer Address      Session       Uptime   Family         Received   Advertised
65010      65001     10.90.254.1:179   established   47m11s   ipv4/unicast   11         12

=== stanton-02 ===
Local AS   Peer AS   Peer Address      Session       Uptime   Family         Received   Advertised
65010      65001     10.90.254.1:179   established   47m55s   ipv4/unicast   11         12

=== stanton-03 ===
Local AS   Peer AS   Peer Address      Session       Uptime   Family         Received   Advertised
65010      65001     10.90.254.1:179   established   48m11s   ipv4/unicast   11         12
```

To see what routes the cluster is advertising:

```bash
kubectl exec -n kube-system ds/cilium -- cilium-dbg bgp routes advertised ipv4 unicast peer 10.90.254.1
```

```
VRouter   Prefix           NextHop       Age      Attrs
65010     10.99.8.201/32   10.90.3.101   51m26s   [{Origin: i} {AsPath: 65010} {Nexthop: 10.90.3.101}]
65010     10.99.8.202/32   10.90.3.101   51m25s   [{Origin: i} {AsPath: 65010} {Nexthop: 10.90.3.101}]
65010     10.99.8.203/32   10.90.3.101   51m31s   [{Origin: i} {AsPath: 65010} {Nexthop: 10.90.3.101}]
65010     10.99.8.204/32   10.90.3.101   51m30s   [{Origin: i} {AsPath: 65010} {Nexthop: 10.90.3.101}]
65010     10.99.8.205/32   10.90.3.101   51m11s   [{Origin: i} {AsPath: 65010} {Nexthop: 10.90.3.101}]
65010     10.99.8.206/32   10.90.3.101   51m11s   [{Origin: i} {AsPath: 65010} {Nexthop: 10.90.3.101}]
65010     10.99.8.207/32   10.90.3.101   51m32s   [{Origin: i} {AsPath: 65010} {Nexthop: 10.90.3.101}]
65010     10.99.8.208/32   10.90.3.101   51m10s   [{Origin: i} {AsPath: 65010} {Nexthop: 10.90.3.101}]
65010     10.99.8.209/32   10.90.3.101   51m26s   [{Origin: i} {AsPath: 65010} {Nexthop: 10.90.3.101}]
65010     10.99.8.210/32   10.90.3.101   51m24s   [{Origin: i} {AsPath: 65010} {Nexthop: 10.90.3.101}]
65010     10.99.8.211/32   10.90.3.101   51m32s   [{Origin: i} {AsPath: 65010} {Nexthop: 10.90.3.101}]
```

### Verifying Routes on the UDM Pro

The real proof is checking that the UDM Pro has actually installed these BGP routes. SSH into the UDM and check:

```bash
ssh unifi "ip route show proto bgp"
```

```
10.99.8.201 metric 20
	nexthop via 10.90.3.101 dev br0 weight 1
	nexthop via 10.90.3.102 dev br0 weight 1
	nexthop via 10.90.3.103 dev br0 weight 1
10.99.8.202 metric 20
	nexthop via 10.90.3.101 dev br0 weight 1
	nexthop via 10.90.3.102 dev br0 weight 1
	nexthop via 10.90.3.103 dev br0 weight 1
10.99.8.203 metric 20
	nexthop via 10.90.3.101 dev br0 weight 1
	nexthop via 10.90.3.102 dev br0 weight 1
	nexthop via 10.90.3.103 dev br0 weight 1
...
```

This output is the smoking gun:

1. **`proto bgp`** — Routes were learned via BGP, not statically configured
2. **Multiple nexthops** — ECMP (Equal-Cost Multi-Path) is active; each LoadBalancer IP has three paths (one per node)
3. **Equal weight** — Traffic is load-balanced across all nodes

The UDM Pro will distribute incoming traffic for any `10.99.8.x` IP across all three cluster nodes. Cilium on each node then delivers the traffic to the correct pod.

### End-to-End Connectivity Test

Finally, verify that services are actually reachable via their BGP-advertised IPs:

```bash
# Test from inside the cluster
kubectl run bgp-test --rm -it --restart=Never --image=busybox:1.36 -- \
  sh -c "nc -zv 10.99.8.207 6379 && echo 'Dragonfly reachable'"

# Output:
# 10.99.8.207 (10.99.8.207:6379) open
# Dragonfly reachable

kubectl run bgp-test --rm -it --restart=Never --image=busybox:1.36 -- \
  sh -c "nc -zv 10.99.8.211 5432 && echo 'Postgres reachable'"

# Output:
# 10.99.8.211 (10.99.8.211:5432) open
# Postgres reachable
```

### Verification Summary

| Check | Status | Details |
|-------|--------|---------|
| BGP CRDs deployed | ✅ | All 4 CRDs present |
| IP Pool | ✅ | `10.99.8.0/24` with 243 IPs available |
| BGP session (stanton-01) | ✅ | Established, 12 routes advertised |
| BGP session (stanton-02) | ✅ | Established, 12 routes advertised |
| BGP session (stanton-03) | ✅ | Established, 12 routes advertised |
| Routes in UDM | ✅ | 11 `/32` routes with `proto bgp` |
| ECMP enabled | ✅ | 3 nexthops per route |
| L2 policies removed | ✅ | No `CiliumL2AnnouncementPolicy` found |
| Service connectivity | ✅ | All LoadBalancer IPs reachable |

## The Numbers

| Metric | Before (L2) | After (BGP) |
|--------|-------------|-------------|
| IP range | `10.90.3.200-210` (shared subnet) | `10.99.8.0/24` (dedicated VLAN) |
| Advertisement method | ARP | BGP route announcements |
| Routing resilience | Single ARP responder | Multiple BGP paths possible |
| Configuration files | Scattered hardcoded IPs | Centralized in cluster-settings |
| Subnet flexibility | Must be on node L2 segment | Any routable subnet |

## Lessons Learned

1. **BGP is simpler than it looks** — The four Cilium CRDs are straightforward once you understand the model: pool defines IPs, advertisement defines what to announce, peer config defines how, cluster config ties it together.

2. **Centralize your IPs** — Having all LoadBalancer IPs in one ConfigMap makes changes easy and prevents the drift that comes from editing 15 different HelmReleases.

3. **Restart pods after network changes** — Pods cache DNS and connection state. After changing IPs or network paths, restart affected workloads to pick up fresh state.

4. **Dedicated subnets are worth it** — Moving LoadBalancer IPs to their own VLAN provides clean separation and makes firewall rules simpler.

5. **BGP health checks are noisy** — If you see mysterious connection attempts to your LoadBalancer services, it's probably Cilium verifying reachability. Check your BGP config before debugging application issues.

## The Gotcha: Flux substituteFrom

One issue that bit me: the envoy-gateway Gateways showed `null` for their addresses. The problem was that the `envoy-gateway-config` Kustomization was missing `postBuild.substituteFrom`:

```yaml
# kubernetes/apps/network/envoy-gateway/ks.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: envoy-gateway-config
  namespace: network
spec:
  # ... other config ...
  postBuild:
    substituteFrom:
      - kind: ConfigMap
        name: cluster-settings
      - kind: Secret
        name: cluster-secrets
```

Without this, Flux doesn't substitute variables like `${ENVOY_INTERNAL_LBIP}`, and they render as literal `null` in the output. The parent Kustomization patches handle this for most resources, but `envoy-gateway-config` needed it explicitly because it's a separate Kustomization with its own path.

---

## References

- [Cilium BGP Control Plane](https://docs.cilium.io/en/stable/network/bgp-control-plane/) — Official documentation
- [CiliumBGPClusterConfig CRD](https://docs.cilium.io/en/stable/network/bgp-control-plane/bgp-control-plane-v2/) — New v2 BGP API
- [UniFi BGP Configuration](https://help.ui.com/hc/en-us/articles/360050737353-UniFi-Network-BGP) — Setting up BGP on UDM Pro

---

*This post documents the BGP migration I performed on my [home-ops](https://github.com/gavinmcfall/home-ops) repository. The centralized LBIP pattern and BGP configuration were refined through several iterations with help from Claude Code.*
