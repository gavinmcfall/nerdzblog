---
title: "Tesla Integration with Home Assistant"
description: "Setting up the offical Tesla Fleet Addon for Home-Assistant with Kubernetes"
date: 2025-08-08
slug: "2025/tesla-fleet-hass"
toc: true
draft: false
Tags:
  - Ollama
  - LLM
  - Open-WebUI
  - Kubernetes
  - Homelab
Categories: [Automation, Homelab, Tesla]
---

> "TL;DR Tesla don't make this simple, Kubernetes with proper security makes it worse"

# Tesla Fleet Integration in Kubernetes: The Real-World Guide

"Sometimes the best smart home setup is the one that actually works — even if it means fighting Kubernetes for three hours."

## Intro

I've been following [This Smart House's excellent guide](https://thissmart.house/2025/07/03/%F0%9F%9A%97-full-smart-home-control-of-your-tesla-with-home-assistants-tesla-fleet-integration/) on setting up Tesla Fleet integration with Home Assistant, but let's be honest — it's written for Home Assistant OS with add-ons, not containerized deployments in Kubernetes.

After wrestling with file permissions, mount conflicts, and Tesla's overly complex API requirements, I finally got it working. Here's what I learned, including all the gotchas that'll save you hours of frustration.

**Full credit to [This Smart House](https://thissmart.house/) for the original guide** — this is essentially a Kubernetes adaptation of their excellent work.

## Why This Integration Matters

Tesla's new Fleet API integration lets you:
- Lock/unlock your Tesla from Home Assistant
- Start climate control remotely
- Monitor charging status and battery levels
- Control charging rates
- Create automations (pre-heat before you leave, charge during solar peak, etc.)

All without opening the Tesla app. It's the real deal for smart home automation.

## Prerequisites

Before diving in, make sure you have:
- Tesla account with at least one vehicle
- Home Assistant running in Kubernetes (I'm using the [bjw-s app-template](https://github.com/bjw-s/helm-charts/tree/main/charts/other/app-template))
- External domain with proper SSL (Tesla won't work with self-signed certs)
- ingress-nginx controller (I have not yet moved to Gateway API)
- External-secrets-operator with 1Password (optional, but recommended)

## The Kubernetes Challenges

The original guide assumes you're using Home Assistant OS add-ons for:
- NGINX SSL Proxy Add-on (for serving public keys)
- Advanced SSH & Web Terminal (for generating encryption keys)
- File system access (for placing keys in specific locations)

**In Kubernetes, we need to handle all of this differently.**

## Step 1: Generate Tesla Fleet Encryption Keys

Tesla requires ECDSA P-256 encryption keys for secure communication. Generate these locally:

```bash
# Generate private key
openssl ecparam -name prime256v1 -genkey -noout -out tesla_fleet.key

# Generate public key
openssl ec -in tesla_fleet.key -pubout -out public-key.pem
```

Store these safely — you'll need both for the setup.

## Step 2: Tesla Developer Portal Setup

1. Go to [developer.tesla.com](https://developer.tesla.com) and create an account
2. Create a new application with these settings:
   - **OAuth Grant Type**: Authorization Code and Machine-to-Machine
   - **Allowed Origin URL**: `https://your-hass-domain.com` e.g. hass.domain.com
   - **Redirect URI**: `https://my.home-assistant.io/redirect/oauth`
   - **Scopes**: Select ALL available scopes (Vehicle Information, Vehicle Location, Vehicle Commands, Vehicle Charging Management, Energy Product Information, Energy Product Commands)

**Critical gotcha**: Make sure you specifiy the sub domain for home-assistant, if you select the root domain this doesnt work.

## Step 3: Serving the Public Key (The Hard Part)

Tesla needs to access your public key at `https://your-domain.com/.well-known/appspecific/com.tesla.3p.public-key.pem`.

### The Mount Approach (Doesn't Work)

My first instinct was to mount the public key file and serve it:

```yaml
# DON'T DO THIS - it causes mount conflicts
persistence:
  tesla-keys:
    type: secret
    name: home-assistant-secret
    globalMounts:
      - path: /.well-known/appspecific/com.tesla.3p.public-key.pem
        subPath: tesla_public_key
        readOnly: true
```

**This fails spectacularly** with "not a directory" errors because Kubernetes can't create the deep directory structure required.

### The Working Solution: nginx Ingress

Instead, serve the public key content directly via nginx:

```yaml
ingress:
  tesla-key:
    annotations:
      external-dns.alpha.kubernetes.io/target: external.${SECRET_DOMAIN}
      nginx.ingress.kubernetes.io/server-snippet: |
        location = /.well-known/appspecific/com.tesla.3p.public-key.pem {
          return 200 "-----BEGIN PUBLIC KEY-----
        YOUR_ACTUAL_PUBLIC_KEY_CONTENT_HERE
        -----END PUBLIC KEY-----";
          add_header Content-Type application/x-pem-file;
        }
    className: external
    hosts:
      - host: hass.${SECRET_DOMAIN}
        paths:
          - path: /.well-known/appspecific/com.tesla.3p.public-key.pem
            pathType: Exact
            service:
              identifier: app
              port: http
```

This bypasses all the file mounting complexity and serves the key directly from nginx.

## Step 4: The Private Key Challenge

Home Assistant needs the private key at `/config/tesla_fleet.key`. With `readOnlyRootFilesystem: true`, you can't just write files to the container.

### The Permission Dance

Here's the process that actually works:

**1. Temporarily disable read-only filesystem:**

```yaml
containers:
  app:
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: false  # Temporarily disable
      capabilities: {drop: ["ALL"]}
```

**2. Apply and create the file:**

```bash
kubectl exec -it deployment/home-assistant -c app -- sh -c 'cat > /config/tesla_fleet.key << "EOF"
-----BEGIN EC PRIVATE KEY-----
YOUR_PRIVATE_KEY_CONTENT_HERE
-----END EC PRIVATE KEY-----
EOF'
```

**3. Re-enable read-only filesystem:**

```yaml
containers:
  app:
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true   # Re-enable
      capabilities: {drop: ["ALL"]}
```

The file persists on the PVC even after re-enabling read-only mode.

## Step 5: Domain Registration with Tesla

This step is **critical** and often overlooked. You must register your domain with Tesla's Fleet API before they'll accept your public key.

**Get an access token:**

```bash
curl --request POST \
--header 'Content-Type: application/x-www-form-urlencoded' \
--data-urlencode 'grant_type=client_credentials' \
--data-urlencode 'client_id=YOUR_CLIENT_ID' \
--data-urlencode 'client_secret=YOUR_CLIENT_SECRET' \
--data-urlencode 'scope=openid vehicle_device_data vehicle_cmds vehicle_location vehicle_charging_cmds energy_device_data energy_cmds' \
--data-urlencode 'audience=https://fleet-api.prd.na.vn.cloud.tesla.com' \
'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token'
```

**Register your domain:**

```bash
curl --location 'https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/partner_accounts' \
--header 'Content-Type: application/json' \
--header 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
--data '{"domain": "your-hass-domain.com"}'
```

**Include ALL scopes** in the token request — missing scopes here will limit what the Home Assistant integration can do later.

## Step 6: File Permission Gotchas

If you run into permission issues (and you probably will), here's the fix that actually works:

**Update your pod security context:**

```yaml
defaultPodOptions:
  securityContext:
    runAsNonRoot: true
    runAsUser: 568
    runAsGroup: 568
    fsGroup: 568
    fsGroupChangePolicy: Always  # This is critical
    seccompProfile: {type: RuntimeDefault}
```

**The key insight**: `fsGroupChangePolicy: Always` ensures all files created in mounted volumes get proper ownership, preventing the auth file permission errors that can break Home Assistant startup.

## Step 7: Home Assistant Integration

Once everything is set up:

1. **Add the Tesla Fleet integration** in Home Assistant
2. **Enter your Client ID and Secret**
3. **Set private key path to**: `/config/tesla_fleet.key`
4. **Complete the OAuth flow**

If you've done everything correctly, you'll get all scopes including Vehicle Commands, and you can finally control your Tesla from your smart home.

## The Complete Working Configuration

Here's my final working configuration:

**[After (working)](https://github.com/gavinmcfall/home-ops/blob/894dce1c6d1f80979db4ad52195db7f04aae9b12/kubernetes/apps/home-automation/home-assistant/app/helmrelease.yaml)** — serving public key via nginx, manual private key creation

## Key Lessons Learned

**Tesla API Gotchas:**
- HASS subdomin must be used
- Domain registration is mandatory before public key acceptance
- All scopes must be included in the domain registration token
- Public key format is extremely picky about line breaks

**Kubernetes Gotchas:**
- Can't mount files to deep directory paths (`/.well-known/appspecific/...`)
- `readOnlyRootFilesystem` prevents file creation even in mounted volumes
- File permissions get messy when switching between privileged/unprivileged containers
- `fsGroupChangePolicy: Always` is essential for proper file ownership

**Home Assistant Gotchas:**
- The integration requires the private key file path, not the content
- OAuth scopes are determined by your Tesla Developer app, not the HA integration
- Deleting and re-adding the integration is often necessary for scope updates

## The Stupid Simple Alternative

If you're reading this and thinking "this is way too complex," you're right. Most people should probably just:
1. Use Home Assistant OS
2. Install the NGINX add-on
3. Follow the original guide

But if you're committed to running everything in Kubernetes (like I am), this is how you make it work.

## Final Thoughts

Tesla's Fleet API setup is unnecessarily convoluted for what should be a straightforward integration. The combination of encryption keys, domain registration, public key serving, and OAuth flows feels like security theater more than actual security.

That said, once it's working, the integration is solid. Being able to pre-condition your Tesla from a Home Assistant automation, or automatically adjust charging rates based on solar production, makes the setup pain worth it.

**Full credit again to [This Smart House](https://thissmart.house/2025/07/03/%F0%9F%9A%97-full-smart-home-control-of-your-tesla-with-home-assistants-tesla-fleet-integration/) for the original comprehensive guide.** Their work made this Kubernetes adaptation possible.

Now if you'll excuse me, I'm going to go start my car's climate control from my smartwatch like the proper nerd I am.

---

*You can find my complete home-ops configuration on [GitHub](https://github.com/gavinmcfall/home-ops). Feel free to steal whatever works for your setup.*