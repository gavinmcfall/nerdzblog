---
title: QBitorrent Woes
description: "All connections stopped"
date: 2025-02-03
slug: "2025/qbitorrent-woes"
toc: true
math: false
draft: false
Tags:
  - Kubernetes
  - Downloads
  - Credentials
Categories: [Kubernetes]
---

> "A lesson learned and not remembered is a mistake waiting to happen again."  
> — *Unknown*

## All activity halted

I awoke Sunday morning to see that all my Linux ISOs had stopped downloading. All stalled.
I kicked my container, but alas, no change

Checking my logs I could see that my wg0 (Wireguard) interface was in an `Unknown` state and that I had no connection to the outside world.

## My Setup

I run a pod with 3 containers in it

- QBitorrent - `cross-platform free and open-source BitTorrent client written in native C++.`
- Glueten - 
    `VPN client in a thin Docker container for multiple VPN providers, written in Go, and using OpenVPN or Wireguard, DNS over TLS, with a few proxy servers built-in. `
- gluetun-qb-port-sync - `As its written on the tin, sync the ports between gluten and qbitorrent`

This is coupled with ProtonVPN (VPN Plus).

## The errors

```bash
gluetun 2025-02-02T19:28:42Z INFO [wireguard] Wireguard setup is complete. Note Wireguard is a silent protocol and it may or may not work, without giving any error message. Typically i/o timeout errors indicate the Wireguard connection is not working.
gluetun 2025-02-02T19:28:55Z INFO [healthcheck] program has been unhealthy for 11s: restarting VPN (healthcheck error: dialing: dial tcp4: lookup cloudflare.com: i/o timeout)
luetun 2025-02-02T19:28:55Z INFO [healthcheck] ≡ƒæë See https://github.com/qdm12/gluetun-wiki/blob/main/faq/healthcheck.md
gluetun 2025-02-02T19:28:55Z INFO [healthcheck] DO NOT OPEN AN ISSUE UNLESS YOU READ AND TRIED EACH POSSIBLE SOLUTION
luetun 2025-02-02T19:28:55Z INFO [vpn] stopping
gluetun 2025-02-02T19:28:55Z ERROR [vpn] waiting for DNS to be ready: context canceled
gluetun 2025-02-02T19:28:55Z ERROR [vpn] getting public IP address information: context canceled
gluetun 2025-02-02T19:28:55Z INFO [port forwarding] starting
gluetun 2025-02-02T19:28:55Z ERROR [vpn] starting port forwarding service: getting VPN assigned IP address: network interface wg0 not found: route ip+net: no such network interface
gluetun 2025-02-02T19:28:55Z INFO [vpn] starting
gluetun 2025-02-02T19:28:55Z INFO [firewall] allowing VPN connection...
gluetun 2025-02-02T19:28:55Z INFO [wireguard] Using available kernelspace implementation
```

Being a networking n00b, I could not figure out what the issue was. My Subscription was still valid, nothing else had changed...

### Culprit Found

After posting a support ticket in the [Home-Operations](https://discord.gg/home-operations) Discord, a very helpful community member suggested that I recreate my wireguard config file and apply it.

I log into [ProtonVPN Downloads page](https://account.protonvpn.com/downloads) to generate the wireguard config (you have to scroll down below OpenVPN) and I see this:

![Proton VPN Credentials expires](/proton-expired.png)

My Credentials had expired...

### The Fix

Generate a new config file using the settings below. It should automatically pickup the best server for you and show it on step4

![Proton VPN Wireguard Config](/new-wg-configpng)

Download the config file and open it in your favorite text editor

Inside you will have four values you will need

1.  Endpoint
1.  PublicKey
1.  PrivateKey
1.  Address

Assuming you are using the [same setup as I am](https://github.com/gavinmcfall/home-ops/tree/main/kubernetes/apps/downloads/qbittorrent)

You will need to update 1Password with the new values

1.  Endpoint = `QBITTORRENT_VPN_ENDPOINT_IP`
1.  PublicKey = `QBITTORRENT_WIREGUARD_PUBLIC_KEY`
1.  PrivateKey = `QBITTORRENT_WIREGUARD_PRIVATE_KEY`
1.  Address = `QBITTORRENT_WIREGUARD_ADDRESSES`

Once this is done, you can run the following command to annotate the secret file so it updates with the changes (change the namespace and secret name accordingly)

```bash
kubectl --namespace downloads annotate externalsecret qbittorrent force-sync=$(date +%s) --overwrite
```

Then you can confirm the secret has changed using

```bash
kubectl get secret -n downloads qbittorrent-secret -o json | jq -r '.data | to_entries[] | "\(.key): \(.value | @base64d)"'
```

Once that is done, your Qbittorrent container should terminate and spin up a fresh container. Give it a few minutes and downloading should resume.