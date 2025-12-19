---
title: "When BGP Doesn't Fix Hairpin: Cilium DSR and the Same-Node Problem"
description: "BGP was supposed to fix my hairpin routing issues. It didn't. Here's how CoreDNS rewriting saved the day when pods couldn't reach LoadBalancer VIPs on the same node."
date: 2025-12-20
slug: "2025/cilium-dsr-hairpin-workaround"
toc: true
math: false
draft: false
Tags:
  - Cilium
  - Kubernetes
  - Homelab
  - Networking
  - CoreDNS
  - BGP
Categories: [Networking, Homelab]
---

> "I thought BGP was supposed to solve this hairpin nonsense I had with L2?"
> — *Me, staring at timeout errors*

## The Setup

Last week I [migrated from Cilium L2 announcements to BGP](/2025/cilium-bgp-migration/) for LoadBalancer IP advertisement. The migration went smoothly — BGP sessions established, routes advertised, services reachable. I patted myself on the back for solving the hairpin routing issues that plagued L2 announcements.

Then `qui` stopped working.

## The Symptom

The `qui` pod (a qBittorrent web UI) was failing its startup probe:

```
Warning  Unhealthy  4s (x14 over 70s)  kubelet  Startup probe failed:
  Get "http://10.69.0.144:7476/health": context deadline exceeded
  (Client.Timeout exceeded while awaiting headers)
```

Looking at the pod logs told the real story:

```json
{"level":"warn","error":"Get \"https://id.nerdz.cloud/.well-known/openid-configuration\":
  dial tcp 10.99.8.202:443: i/o timeout","attempt":1,"issuer":"https://id.nerdz.cloud",
  "message":"failed to initialize OIDC provider candidate"}
```

The app was timing out trying to reach my OIDC provider at `id.nerdz.cloud`. The health endpoint wasn't responding because the app was stuck waiting for OIDC initialization.

## The Investigation

My first instinct: test connectivity from the pod.

```bash
kubectl exec -n downloads qui-79cf57dcb-5qss8 -- wget -qO- --timeout=5 \
  https://id.nerdz.cloud/.well-known/openid-configuration
```

Timeout.

But wait — from a debug pod on a different node:

```bash
kubectl run debug --image=busybox --restart=Never -- sleep 300
kubectl exec debug -- wget -qO- --timeout=5 \
  https://id.nerdz.cloud/.well-known/openid-configuration
```

Success. Full JSON response.

The pattern emerged: pods on `stanton-01` couldn't reach `10.99.8.202` (the LoadBalancer VIP for my internal gateway), but pods on `stanton-02` and `stanton-03` could.

What was special about `stanton-01`? Let's check:

```bash
kubectl get pods -n network -l gateway.envoyproxy.io/owning-gateway-name=internal -o wide
```

```
NAME                                              NODE
envoy-network-internal-f0b82637-c98c4cbd8-c8mjh   stanton-01
```

The envoy-internal pod — the backend for `10.99.8.202` — was running on `stanton-01`. Same node as the failing `qui` pod.

## The Root Cause: DSR and Same-Node Hairpin

Cilium's DSR (Direct Server Return) mode is great for external traffic:

1. Client sends packet to LoadBalancer VIP
2. Router (UDM Pro) forwards to a cluster node via BGP
3. Cilium DNATs to the backend pod
4. Backend sends response **directly** back to client (skipping the load balancer)

This preserves client IPs and reduces latency. But it breaks when the source and destination are on the same node.

Here's what happens when a pod on `stanton-01` tries to reach `10.99.8.202`:

```
qui pod (stanton-01)
    │
    │ 1. Send packet to 10.99.8.202
    ▼
Cilium BPF (stanton-01)
    │
    │ 2. "10.99.8.202 is an ExternalIP, not in my routing table"
    │    Route to default gateway (UDM Pro)
    ▼
UDM Pro
    │
    │ 3. BGP route says 10.99.8.202 → stanton-01
    │    Send back to stanton-01
    ▼
???
    │
    │ 4. Packet bounces or gets dropped
    ▼
Timeout
```

The problem is that Cilium's DSR mode doesn't intercept traffic to LoadBalancer VIPs from pods — it's designed for external traffic entering the cluster. The packet goes out to the router, the router sends it back, and something breaks in the return path.

This is [a known Cilium limitation](https://github.com/cilium/cilium/issues/39198). The GitHub issue title says it all: "Pods are not able to reach Cilium-managed LoadBalancer IP."

## What I Tried (And What Didn't Work)

### Attempt 1: Socket LB

The first suggestion in the docs: enable socket-level load balancing.

```yaml
# helm-values.yaml
socketLB:
  enabled: true
```

Socket LB intercepts connections at the `connect()` syscall, before packets hit the network. In theory, it should handle hairpin traffic. In practice:

```bash
kubectl exec debug-fresh -- curl --connect-timeout 5 http://10.99.8.202:80
# Connection timed out after 5002 milliseconds
```

Socket LB helps with ClusterIP services, but it doesn't intercept ExternalIP/LoadBalancer traffic.

### Attempt 2: Hybrid Mode

Maybe the problem is pure DSR. What about hybrid mode?

```yaml
loadBalancer:
  mode: hybrid  # DSR for external, SNAT for internal
```

Nope. Still timing out.

### Attempt 3: lbExternalClusterIP

There's an option to allow cluster-internal access to external LB IPs:

```yaml
loadBalancer:
  lbExternalClusterIP: true
```

Also didn't work.

At this point I'd tried everything in the Cilium docs. The problem is fundamental to how BGP + native routing + DSR interact. Pods simply can't reach LoadBalancer VIPs via the normal packet path when the backend is on the same node.

## The Solution: CoreDNS Rewriting

If I can't fix the network path, I can fix the DNS. The key insight: pods don't *need* to hit the LoadBalancer VIP — they can use the ClusterIP instead.

| Client | Should resolve to |
|--------|------------------|
| External (internet) | LoadBalancer VIP `10.99.8.202` |
| Pod (internal) | ClusterIP `10.96.9.253` |

CoreDNS can make this happen with the `template` plugin:

```yaml
# kubernetes/apps/kube-system/coredns/app/helm-values.yaml
servers:
  # Internal gateway rewrite - resolves internal services to ClusterIP
  # This works around Cilium DSR hairpin limitation
  - zones:
      - zone: ${SECRET_DOMAIN}
        scheme: dns://
    port: 53
    plugins:
      - name: errors
      - name: log
        configBlock: |-
          class error
      - name: template
        parameters: IN A
        configBlock: |-
          match (^internal\.|^id\.)nerdz\.cloud\.$
          answer "{{ .Name }} 60 IN A ${ENVOY_INTERNAL_CLUSTERIP}"
          fallthrough
      - name: template
        parameters: IN AAAA
        configBlock: |-
          match (^internal\.|^id\.)nerdz\.cloud\.$
          rcode NOERROR
          fallthrough
      - name: forward
        parameters: . /etc/resolv.conf
      - name: cache
        parameters: 30
```

The `ENVOY_INTERNAL_CLUSTERIP` variable is defined in `cluster-settings.yaml` and substituted by Flux. This way if the ClusterIP ever changes (e.g., if the service is recreated), you only need to update one place.

The template matches queries for `internal.nerdz.cloud` and `id.nerdz.cloud` and returns the ClusterIP instead of forwarding to external DNS (which would return the LoadBalancer VIP).

### Why Both Domains?

My DNS is set up with a CNAME:

```
id.nerdz.cloud → internal.nerdz.cloud → 10.99.8.202 (LB VIP)
```

If I only intercept `internal.nerdz.cloud`, the CNAME lookup for `id.nerdz.cloud` goes to external DNS, which returns the CNAME, and then the A record lookup for `internal.nerdz.cloud` also goes to external DNS. The whole chain bypasses my template.

By intercepting both domains, I catch the query before it ever leaves the cluster.

## Verification

After deploying the CoreDNS change:

```bash
# From a pod on stanton-01
kubectl exec debug-dns -- nslookup id.nerdz.cloud
```

```
Server:    10.96.0.10
Address:   10.96.0.10#53

Name:      id.nerdz.cloud
Address:   10.96.9.253    # ClusterIP, not LB VIP!
```

And the OIDC endpoint:

```bash
kubectl exec debug-dns -- curl -s https://id.nerdz.cloud/.well-known/openid-configuration | head -c 100
```

```json
{"authorization_endpoint":"https://id.nerdz.cloud/authorize","authorization_response_iss_parameter_supported":true...
```

The `qui` pod now starts without timing out:

```bash
kubectl get pods -n downloads -l app.kubernetes.io/name=qui
```

```
NAME                  READY   STATUS    RESTARTS   AGE
qui-79cf57dcb-hn6dj   1/1     Running   0          2m
```

## The Trade-off

This solution has a subtle implication: internal pod traffic to `id.nerdz.cloud` won't hit the LoadBalancer layer. It goes directly to the envoy-internal ClusterIP.

In practice, this doesn't matter — ClusterIP load balancing is still handled by Cilium, and there's only one replica of envoy-internal anyway. But if you're doing something fancy with LoadBalancer-level policies or metrics, be aware that pod traffic bypasses that layer.

## Lessons Learned

1. **BGP fixes L2 hairpin, not DSR hairpin** — L2 announcements had hairpin issues because one node "owned" the IP via ARP. BGP fixed that by routing through the router. But DSR mode has its own hairpin problem when source and backend share a node.

2. **ClusterIP always works** — When in doubt, use ClusterIP for pod-to-service traffic. It's what Kubernetes expects.

3. **DNS is a powerful escape hatch** — When the network layer is fighting you, sometimes the answer is above the network layer. CoreDNS templates let you intercept and rewrite queries before they ever become packets.

4. **Test from the same node** — My initial testing from different nodes missed the issue entirely. When debugging network problems, always test from the specific node(s) having issues.

5. **Read the GitHub issues** — The Cilium issue tracker is full of people hitting this exact problem. I could have saved hours by searching for "pods cannot reach LoadBalancer IP" earlier.

## The Fix in Context

| Problem | Solution |
|---------|----------|
| L2 hairpin (ARP ownership) | Migrate to BGP |
| DSR same-node hairpin | CoreDNS rewrite to ClusterIP |
| General pod-to-LB access | Use ClusterIP or service DNS |

BGP was the right call for L2 hairpin. But DSR mode introduced a new hairpin scenario that BGP doesn't solve. CoreDNS rewriting is the cleanest workaround I've found — it's targeted, doesn't require Cilium changes, and works regardless of pod scheduling.

---

## References

- [Cilium Issue #39198](https://github.com/cilium/cilium/issues/39198) — Pods are not able to reach Cilium-managed LoadBalancer IP
- [Cilium DSR Documentation](https://docs.cilium.io/en/stable/network/kubernetes/kubeproxy-free/#direct-server-return-dsr) — How DSR mode works
- [CoreDNS Template Plugin](https://coredns.io/plugins/template/) — Synthesizing DNS responses
- [From L2 to BGP](/2025/cilium-bgp-migration/) — The migration that started this journey

---

*This post documents a debugging session with help from Claude Code. The CoreDNS workaround is now part of my [home-ops](https://github.com/gavinmcfall/home-ops) repository.*
