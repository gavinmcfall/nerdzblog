---
title: "Running Game Servers from a NAS: Pterodactyl + TrueNAS"
description: "Deploying Pterodactyl Panel on Kubernetes with Wings running on TrueNAS for self-hosted game server management"
date: 2026-01-10
slug: "2026/pterodactyl-truenas-setup"
toc: true
math: false
draft: false
Tags:
  - Pterodactyl
  - TrueNAS
  - Kubernetes
  - Homelab
  - Gaming
  - Docker
Categories: [Gaming, Homelab]
---

> "Why pay for game server hosting when you have a 56-thread NAS sitting idle?"
> — *Me, justifying another homelab project*

## The Problem: Game Server Sprawl

I've been running various game servers over the years — Minecraft for the kids, Valheim with friends, the occasional ARK survival session. Each one was its own snowflake: different install methods, different backup strategies, different ways of breaking at 2am when someone actually wanted to play.

What I wanted was something like Proxmox for VMs, but for game servers: a web UI where I could spin up a Minecraft server in 30 seconds, manage backups, and not have to SSH into anything unless something was on fire.

Enter [Pterodactyl](https://pterodactyl.io/).

## What is Pterodactyl?

Pterodactyl is an open-source game server management panel. It's what companies like Apex Hosting and Nodecraft use under the hood (or something similar). The architecture is split into two components:

| Component | Purpose |
|-----------|---------|
| **Panel** | Web UI for managing servers, users, allocations |
| **Wings** | Daemon that actually runs the game server containers |

The Panel is a Laravel app — database, Redis, the usual web stack. Wings is a Go binary that talks to Docker and manages the actual game server containers.

In my setup:
- **Panel** runs on Kubernetes (GitOps, because everything in my homelab is GitOps)
- **Wings** runs on TrueNAS (where I have the storage and spare compute for game servers)

## Why TrueNAS for Wings?

My Kubernetes cluster is three nodes with NVMe storage, optimised for services that need to be highly available. Game servers... don't really fit that mould. They're stateful, they want lots of RAM and CPU, and if a Minecraft server goes down for 30 seconds during a node reboot, the kids will survive.

TrueNAS, on the other hand, has:
- 56 CPU threads (Xeon goodness)
- 128GB RAM
- Plenty of spinning rust for world saves
- Docker support via the app system

Running Wings on TrueNAS means game servers get dedicated resources without competing with Grafana and Home Assistant for pod scheduling.

## The Journey

### Part 1: Panel Deployment

The Panel deployment was straightforward thanks to the `bjw-s/app-template` chart. The config lives in an ExternalSecret with all the Laravel bits:

```yaml
# The important environment variables
APP_KEY: "{{ .PTERODACTYL_APP_KEY }}"  # Laravel encryption key
APP_URL: https://pterodactyl.nerdz.cloud
DB_HOST: mariadb.database.svc.cluster.local
REDIS_HOST: dragonfly.database.svc.cluster.local

# S3 backups to MinIO
APP_BACKUP_DRIVER: s3
AWS_ENDPOINT: http://citadel.internal:9000
AWS_BACKUPS_BUCKET: gameserver-backups
```

The gotchas I hit:
1. **`CADDY_APP_URL: ":80"`** — The container uses Caddy internally, and it needs this set
2. **`TRUSTED_PROXIES`** — Must be CIDR notation (`10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`), not `*`
3. **Database init scripts** — Only run on first MariaDB deployment, so I had to manually create the database

### Part 2: DNS and Networking

This is where it got interesting. Game servers need to be reachable from the internet, which means:
- A DNS record pointing to my external IP
- Port forwards through the UniFi gateway
- SSL certificates for the Wings API

I created `play.nerdz.cloud` pointing to my external IP (not proxied through Cloudflare — game traffic needs direct access).

Port forwards:
| Port | Purpose |
|------|---------|
| 8443 | Wings API (Panel ↔ Wings communication) |
| 2022 | SFTP (file uploads) |
| 25565-25600 | Game servers (36 allocations) |

### Part 3: Wings Won't Start — SSL Certificates

First attempt at starting Wings:

```
FATAL: failed to configure HTTPS server error=open /etc/letsencrypt/live/play.nerdz.cloud/fullchain.pem: no such file or directory
```

Wings expects SSL certificates at a specific path. My options were:
1. Let Wings auto-generate certs via Let's Encrypt (requires port 80 forwarded)
2. Provide my existing wildcard certificate

I went with option 2 — my Kubernetes cluster already has a wildcard cert for `*.nerdz.cloud` via cert-manager. A quick export and copy later:

```bash
# Export from Kubernetes
kubectl get secret envoy-gateway-nerdz-cloud-tls -n network \
  -o jsonpath='{.data.tls\.crt}' | base64 -d > fullchain.pem
kubectl get secret envoy-gateway-nerdz-cloud-tls -n network \
  -o jsonpath='{.data.tls\.key}' | base64 -d > privkey.pem

# Copy to TrueNAS
scp fullchain.pem privkey.pem truenas:/mnt/storage0/game-servers/wings/certs/
```

Then mount them in docker-compose:

```yaml
volumes:
  - "./certs:/etc/letsencrypt/live/play.nerdz.cloud"
```

### Part 4: DNS Resolution from Kubernetes

The Panel needs to talk to Wings at `play.nerdz.cloud:8443`. When I tried to create a node, the Panel couldn't resolve the hostname. After much head-scratching, I traced it to CoreDNS → node's resolv.conf → systemd-resolved with stale cache.

The fix was adding public DNS servers to my Talos nodes:

```yaml
# kubernetes/bootstrap/talos/patches/global/local-dns.yaml
machine:
  network:
    nameservers:
      - 10.90.254.1  # UDM Pro
      - 1.1.1.1      # Cloudflare
      - 8.8.8.8      # Google
```

Applied via `talosctl patch mc` to each node — no reboot required since it's a network config change.

### Part 5: The /tmp Mount Gotcha

With Wings running and the node connected, I created my first Minecraft server. The Panel showed "Installing"... and then nothing. Checking the Wings logs:

```
ERROR: failed to run install process for server error=Error response from daemon:
invalid mount config for type "bind": bind source path does not exist:
/tmp/pterodactyl/407c6b7d-cc34-4d31-a4e3-fa0e51265aa7
```

This one took a while to figure out. Wings creates install scripts in `/tmp/pterodactyl/`, then spawns a container to run them. The problem? My docker-compose had:

```yaml
volumes:
  - "./tmp:/tmp/pterodactyl/"  # WRONG
```

This creates the path *inside* the Wings container, but when Wings spawns the install container, Docker looks for `/tmp/pterodactyl` on the **host** filesystem. The paths need to match:

```yaml
volumes:
  - "/tmp/pterodactyl:/tmp/pterodactyl"  # RIGHT - same path on host and container
```

Create the directory and restart Wings:

```bash
sudo mkdir -p /tmp/pterodactyl
sudo docker compose down && sudo docker compose up -d
```

### Part 6: EULA and First Boot

With the mount fixed, the Minecraft Forge server installed successfully. Started it up and... immediately exited with code 0. The logs showed:

```
You need to agree to the EULA in order to run the server. Go to eula.txt for more info.
```

Classic Minecraft. In Pterodactyl's client view (not admin), go to **Files**, open `eula.txt`, change `eula=false` to `eula=true`, save, and start again.

```
[Server thread/INFO] [minecraft/DedicatedServer]: Done (8.248s)! For help, type "help"
Server marked as running...
```

### Part 7: Testing External Access

The moment of truth. Connected from within my LAN first — worked. But that could just be hairpin NAT through the UDM.

Switched my phone to mobile data, opened Minecraft, added server `play.nerdz.cloud:25565`... and I was in. External access confirmed.

```
[User Authenticator #1/INFO]: UUID of player NZVengeance is 525f1ee0-b0cc-4e07-88d8-4d77ffe25e85
[Server thread/INFO]: NZVengeance joined the game
```

## Importing More Game Eggs

With the infrastructure working, I wanted more than just Minecraft. Pterodactyl uses "eggs" — JSON templates that define how to install and run different game servers.

The community maintains hundreds of eggs at [pelican-eggs](https://github.com/pelican-eggs):

| Repository | Contents |
|------------|----------|
| [games-steamcmd](https://github.com/pelican-eggs/games-steamcmd) | 150+ Steam games |
| [minecraft](https://github.com/pelican-eggs/minecraft) | All Minecraft variants |
| [games-standalone](https://github.com/pelican-eggs/games-standalone) | Non-Steam games |

Importing is straightforward: download the JSON, go to Admin → Nests → Import Egg. I added:
- Satisfactory
- Valheim
- Palworld
- ARK Survival Ascended
- Core Keeper
- Enshrouded
- Conan Exiles
- Icarus
- CurseForge (for modpack servers)
- Factorio

Each game has different port requirements, so I'll need to add more allocations and port forwards as I spin up servers.

## The Final Architecture

```
                                    Internet
                                        │
                                        ▼
                              ┌─────────────────┐
                              │  UniFi Gateway  │
                              │   Port Forward  │
                              └────────┬────────┘
                                       │
            ┌──────────────────────────┼──────────────────────────┐
            │                          │                          │
            ▼                          ▼                          ▼
    ┌───────────────┐         ┌───────────────┐         ┌───────────────┐
    │ Pterodactyl   │         │    Wings      │         │ Game Servers  │
    │    Panel      │◄───────►│  (TrueNAS)    │◄───────►│   (Docker)    │
    │  (Kubernetes) │         │   Port 8443   │         │ Ports 25565+  │
    └───────┬───────┘         └───────────────┘         └───────────────┘
            │
    ┌───────┴───────┐
    │               │
    ▼               ▼
┌────────┐    ┌──────────┐
│MariaDB │    │Dragonfly │
│  (DB)  │    │ (Cache)  │
└────────┘    └──────────┘
```

## Lessons Learned

1. **Wings needs SSL** — Even for internal communication, Wings expects HTTPS. Either provide certs or disable SSL (not recommended).

2. **Volume mounts must match** — When Wings spawns containers, bind mounts use host paths. If your docker-compose uses relative paths inside the container, the spawned containers won't find them.

3. **Docker on TrueNAS works well** — The `network_mode: host` requirement for Wings is handled fine, and having the volumes on ZFS gives me snapshot capabilities for free.

4. **DNS is always the problem** — When in doubt, add more upstream DNS servers. Kubernetes pods relying on node DNS resolution is a foot-gun.

5. **Wildcard certs are worth it** — Having `*.nerdz.cloud` available meant I could just export and use it rather than setting up another Let's Encrypt flow.

6. **Split the control plane from the data plane** — Panel in Kubernetes (HA, GitOps), Wings on TrueNAS (storage, compute). Best of both worlds.

7. **Read the logs** — Both Pterodactyl and Wings have excellent logging. Every problem I hit was clearly explained in the logs once I actually looked.

## What's Next

- **Backup schedules** — Configure automatic backups to the MinIO bucket
- **User management** — Create accounts so the kids can manage their own servers
- **More port forwards** — Different games need different ports (Valheim wants 2456-2457, Satisfactory wants 7777, etc.)
- **Monitoring** — Add Prometheus metrics for game server health

---

## Resources

- [Pterodactyl Documentation](https://pterodactyl.io/project/introduction.html)
- [Wings Docker Setup](https://pterodactyl.io/wings/1.0/installing.html#docker)
- [Pelican Eggs Repository](https://github.com/pelican-eggs)
- [My home-ops repo](https://github.com/gavinmcfall/home-ops) — Full GitOps setup including Pterodactyl manifests
