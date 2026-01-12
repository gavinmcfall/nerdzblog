---
title: "Cloud Provider Roulette: Finding a Home for Redroid"
description: "A journey through TrueNAS, Oracle Cloud, and Hetzner before finally landing on AWS Graviton for running Android containers with acceptable latency from New Zealand."
date: 2026-01-11
slug: "2026/cloud-provider-roulette-redroid"
toc: true
math: false
draft: false
Tags:
  - Android
  - Redroid
  - AWS
  - Oracle Cloud
  - Hetzner
  - Docker
  - ARM
  - Homelab
Categories: [Cloud, Homelab, Android]
---

> "The definition of insanity is doing the same thing over and over and expecting different results. The definition of homelabbing is trying every cloud provider until one doesn't hate you."

## The Goal

I needed an Android device for testing [Bootible](https://github.com/bootible/bootible) — a one-liner provisioning tool for gaming handhelds. The problem: I don't have a spare Android device lying around, and buying one just for development felt wasteful.

Enter Redroid — Android containers that run natively on ARM hardware. No emulation overhead, just containerised Android with ADB access. Connect via scrcpy and you've got a proper Android environment for testing.

Simple enough, right?

## Attempt 1: TrueNAS SCALE

My TrueNAS box has plenty of horsepower — 56 threads, 128GB RAM. Running Redroid there would keep everything local with zero latency. Perfect.

```bash
ssh truenas
sudo apt install linux-modules-extra-$(uname -r)
```

```
Reading package lists... Done
E: dpkg was interrupted, you must manually run 'sudo dpkg --configure -a'
```

Okay, let's try that:

```bash
sudo dpkg --configure -a
```

```
dpkg: error: unable to access dpkg status area: Read-only file system
```

TrueNAS SCALE is not your typical Linux box. It's an appliance with a read-only root filesystem. No installing packages, no loading kernel modules, no Redroid.

**Result**: Dead on arrival.

## Attempt 2: Oracle Cloud A1 (Free Tier)

Oracle Cloud's Always Free tier includes up to 4 ARM OCPUs and 24GB RAM on their Ampere A1 instances. Free ARM compute in Sydney? Sign me up.

1. Created Oracle Cloud account
2. Navigated to Compute → Create Instance
3. Selected VM.Standard.A1.Flex
4. Clicked Create

```
Out of capacity for shape VM.Standard.A1.Flex in availability domain AD-1.
```

Tried AD-2. Same error. AD-3. Same.

This is Oracle Cloud's dirty secret — the free tier instances are perpetually "out of capacity" in popular regions. Sydney? Forget it. You might get lucky at 3am on a Tuesday, but I wasn't willing to write a script to spam the API.

**Result**: Phantom free tier.

## Attempt 3: Oracle Cloud A2 (Paid)

Fine. I'll pay. Oracle A2 instances are the newer Ampere Altra processors. Still ARM, but with actual availability.

```bash
# SSH into new A2 instance
ssh ubuntu@<oracle-a2-ip>

# Install Docker
sudo apt install -y docker.io

# Load binder module
sudo modprobe binder_linux devices=binder,hwbinder,vndbinder

# Run Redroid
docker run -d --name redroid-11 --privileged \
  -p 5555:5555 \
  redroid/redroid:11.0.0-latest
```

The container started. Docker logs showed Android booting. Then:

```
init: cannot execv('/system/bin/boringssl_self_test32'): Exec format error
```

And the entire VM froze. SSH session dead. Console showed kernel panic.

After some research: **Oracle A2 instances don't support 32-bit ARM binaries**. The Ampere Altra processors are 64-bit only. Standard Redroid images include 32-bit compatibility libraries that cause immediate kernel panics.

The fix? Use Redroid's `_64only` images:

```bash
docker run -d --name redroid-13 --privileged \
  -p 5555:5555 \
  redroid/redroid:13.0.0_64only-latest
```

But wait — there's no Android 11 `_64only` image. The oldest is Android 12. And after the kernel panic, I was done fighting with Oracle.

**Result**: Works in theory, terrifying in practice.

## Attempt 4: Hetzner ARM (CAX11)

Hetzner's ARM servers are cheap (~€4/month), available in multiple regions, and most importantly: they support 32-bit ARM binaries.

Created a CAX11 in Helsinki:

```bash
# SSH in
ssh root@<hetzner-ip>

# Install Docker
apt update && apt install -y docker.io

# Load binder module
modprobe binder_linux devices=binder,hwbinder,vndbinder

# Run Redroid
docker run -d --name redroid-11 --privileged \
  -p 5555:5555 \
  redroid/redroid:11.0.0-latest
```

It worked. Android 11 booted, ADB connected, scrcpy displayed the Android home screen.

Then I tried to actually use it:

```bash
tailscale ping <hetzner-tailscale-ip>
```

```
pong from hetzner-android (100.x.x.x) via DERP(fra) in 280ms
```

280 milliseconds. From New Zealand to Helsinki. Every tap, every swipe, every interaction — a quarter-second delay. For development testing, it was borderline unusable.

**Result**: Works, but feels like using Android through molasses.

## Attempt 5: AWS Graviton (Sydney)

At this point I was ready to throw money at the problem. AWS has Graviton instances in Sydney. Their t4g.small is free tier eligible (750 hours/month until December 2026). Let's try it.

```bash
# Create t4g.small in ap-southeast-2
# SSH in
ssh -i ~/.ssh/android.pem ubuntu@<aws-ip>

# Install Docker and kernel modules
sudo apt install -y docker.io linux-modules-extra-$(uname -r)

# Load binder
sudo modprobe binder_linux devices=binder,hwbinder,vndbinder

# Mount binderfs
sudo mkdir -p /dev/binderfs
sudo mount -t binder binder /dev/binderfs

# Run Redroid (64-bit only for Graviton)
docker run -d --name redroid-13 --privileged \
  -p 5555:5555 \
  redroid/redroid:13.0.0_64only-latest
```

Checked boot status:

```bash
docker exec redroid-13 getprop sys.boot_completed
```

```
1
```

Connected from my PC:

```bash
tailscale ping 100.66.154.79
```

```
pong from aws-android (100.66.154.79) via DERP(syd) in 28ms
pong from aws-android (100.66.154.79) via DERP(syd) in 29ms
pong from aws-android (100.66.154.79) via DERP(syd) in 28ms
```

28 milliseconds. Ten times faster than Hetzner. scrcpy was responsive, taps registered instantly, the whole experience felt local.

**Result**: Finally.

## The Scorecard

| Provider | Region | Cost | Latency (NZ) | Result |
|----------|--------|------|--------------|--------|
| TrueNAS | Local | Free | 0ms | Read-only filesystem |
| Oracle A1 | Sydney | Free | N/A | "Out of capacity" forever |
| Oracle A2 | Sydney | ~$15/mo | N/A | Kernel panics (no 32-bit) |
| Hetzner CAX11 | Helsinki | ~€4/mo | 280ms | Works but unusable |
| AWS t4g.small | Sydney | Free tier | 28ms | Works perfectly |

## Lessons Learned

### 1. TrueNAS is an Appliance

Don't try to use TrueNAS SCALE as a general-purpose Linux box. It's designed to run apps through their official app system, not arbitrary Docker containers with kernel module requirements.

### 2. Oracle Cloud Free Tier is a Lie

The A1 instances are theoretically free. In practice, they're never available in useful regions. The paid A2 tier works but has its own problems (see below).

### 3. Not All ARM is Equal

Oracle A2 (Ampere Altra) and AWS Graviton processors are 64-bit only. Standard Redroid images include 32-bit ARM libraries that cause kernel panics. Always use `_64only` variants:

```
redroid/redroid:12.0.0_64only-latest
redroid/redroid:13.0.0_64only-latest
redroid/redroid:14.0.0_64only-latest
```

Hetzner CAX (Ampere eMAG) supports both 32-bit and 64-bit, so standard images work there.

### 4. Geography Matters

For interactive applications like scrcpy, latency is everything. 280ms makes an Android device feel broken. 28ms feels native. Pick a region close to you.

### 5. Free Tier Math

AWS t4g.small gives you 750 hours/month free — that's 24/7 operation with room to spare. The free tier runs until December 2026. After that, it's about $12/month in Sydney. Still cheaper than a dedicated Android device.

### 6. Tailscale is the Answer

Every provider in this journey used Tailscale for access. No public ports exposed, no firewall rules to manage, no VPN certificates to rotate. Just `tailscale up` and you're connected.

## The Final Setup

```
                     Tailscale Mesh
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
         ▼                 ▼                 ▼
   ┌───────────┐    ┌───────────┐    ┌───────────┐
   │  Desktop  │    │   Phone   │    │  Laptop   │
   │  (WSL2)   │    │           │    │           │
   └─────┬─────┘    └───────────┘    └───────────┘
         │
         │ ADB + scrcpy
         │ 28ms RTT
         ▼
   ┌───────────────────────────────────────────┐
   │              AWS ap-southeast-2           │
   │  ┌─────────────────────────────────────┐  │
   │  │           t4g.small                 │  │
   │  │  ┌──────────────────────────────┐   │  │
   │  │  │      Redroid Container       │   │  │
   │  │  │     Android 13 (64-bit)      │   │  │
   │  │  │        Port 5555             │   │  │
   │  │  └──────────────────────────────┘   │  │
   │  └─────────────────────────────────────┘  │
   └───────────────────────────────────────────┘
```

## Quick Reference

```bash
# Check latency
tailscale ping <aws-tailscale-ip>

# Connect ADB
adb connect <aws-tailscale-ip>:5555

# Display with scrcpy (optimised for remote)
scrcpy -s <aws-tailscale-ip>:5555 \
  --max-size 1024 \
  --video-bit-rate 4M \
  --stay-awake

# Check Android boot status
docker exec redroid-13 getprop sys.boot_completed

# Shell into Android
adb -s <aws-tailscale-ip>:5555 shell
```

---

*The full setup guide is in my [home-ops repo](https://github.com/gavinmcfall/home-ops/blob/main/docs/Guides/Cloud%20Compute/Android%20Emulation/aws-redroid-setup.md).*
