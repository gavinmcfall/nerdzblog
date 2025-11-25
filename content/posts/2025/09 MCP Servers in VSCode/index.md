---
title: "Running 14 MCP Servers in VS Code for Homelab Mastery"
description: "How I configured Model Context Protocol servers to give Claude Code superpowers over my Kubernetes cluster"
date: 2025-11-26
slug: "2025/mcp-servers-vscode"
toc: true
math: false
draft: false
Tags:
  - AI
  - MCP
  - VS Code
  - Kubernetes
  - Homelab
  - Claude
Categories: [AI, Homelab]
---

> "Give a man a fish and he eats for a day. Give an AI access to your cluster via MCP and watch it debug your HelmReleases at 2am."
> — *Me, probably sleep-deprived*

## What is MCP?

Model Context Protocol (MCP) is Anthropic's open standard for connecting AI assistants to external tools and data sources. Think of it as giving your AI a set of hands — instead of just chatting, it can actually *do* things: query your Prometheus metrics, check Flux reconciliation status, browse GitHub PRs, or even execute kubectl commands.

If you're running Claude Code in VS Code (or the CLI), MCP servers let you extend what Claude can access. Instead of copy-pasting error logs into the chat, Claude can pull them directly. Instead of describing your cluster state, Claude can just... look.

## The Setup

I run a Kubernetes homelab managed via GitOps (Flux + Talos), and I wanted Claude to have full visibility into everything without me having to be the middleman. After a few evenings of tinkering, I landed on 14 MCP servers that cover infrastructure, observability, databases, code, and more.

Here's what's running:

| Server | Purpose |
|--------|---------|
| `kubernetes` | Native k8s resource access |
| `flux` | GitOps status, reconciliation |
| `talos` | Talos Linux node management |
| `helm` | Chart inspection and values |
| `grafana` | Dashboards, datasources, alerts |
| `prometheus` | PromQL queries, metric discovery |
| `databases` | PostgreSQL + MariaDB queries |
| `github` | PRs, issues, code search |
| `shell` | Controlled command execution |
| `mermaid` | Diagram validation |
| `eraser` | Diagram creation (Eraser.io) |
| `firecrawl` | Web scraping and search |
| `cloudflare-docs` | CF documentation search |
| `repoql` | Semantic codebase queries |

## The Configuration

MCP servers are configured in a `.mcp.json` file. I keep mine in the root of my home-ops repo so it's shared between VS Code and Claude Code CLI.

{{< notice info >}}
MCP does not expand `~/` in paths. Always use full absolute paths like `/home/username/...` instead of `~/...` in your `.mcp.json` configuration.
{{< /notice >}}

Here's the full config:

```json
{
  "mcpServers": {
    "kubernetes": {
      "command": "npx",
      "args": ["-y", "kubernetes-mcp-server@latest"]
    },
    "flux": {
      "command": "flux-operator-mcp",
      "args": ["serve"]
    },
    "talos": {
      "command": "/home/<user>/mcp/talos/.venv/bin/python",
      "args": ["/home/<user>/mcp/talos/src/talos_mcp/server.py"],
      "env": {
        "TALOSCONFIG": "/home/<user>/home-ops/talosconfig"
      }
    },
    "helm": {
      "command": "/home/<user>/mcp/mcp-helm",
      "args": ["-mode=stdio"]
    },
    "grafana": {
      "command": "/home/<user>/go/bin/mcp-grafana",
      "env": {
        "GRAFANA_URL": "${GRAFANA_URL}",
        "GRAFANA_SERVICE_ACCOUNT_TOKEN": "${GRAFANA_SERVICE_ACCOUNT_TOKEN}"
      }
    },
    "shell": {
      "command": "uvx",
      "args": ["mcp-shell-server"],
      "env": {
        "ALLOW_COMMANDS": "ls,cat,pwd,grep,wc,find,head,tail,sort,uniq,cut,tr,sed,awk,jq,yq,kubectl,flux,talosctl,task,git,docker,helm"
      }
    },
    "mermaid": {
      "command": "npx",
      "args": ["-y", "@probelabs/maid-mcp"]
    },
    "eraser": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "ERASER_API_KEY=${ERASER_API_KEY}",
        "eraser-mcp:claude"
      ]
    },
    "github": {
      "command": "/home/<user>/mcp/github-mcp-server",
      "args": ["stdio"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"
      }
    },
    "prometheus": {
      "command": "npx",
      "args": ["-y", "prometheus-mcp@latest", "stdio"],
      "env": {
        "PROMETHEUS_URL": "${PROMETHEUS_URL}"
      }
    },
    "databases": {
      "command": "uvx",
      "args": ["database-mcp"],
      "env": {
        "DB_CONFIGS": "${DB_CONFIGS}"
      }
    },
    "firecrawl": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "${FIRECRAWL_API_KEY}"
      }
    },
    "cloudflare-docs": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://docs.mcp.cloudflare.com/mcp"]
    }
  },
  "servers": {
    "repoql": {
      "type": "stdio",
      "command": "/home/<user>/mcp/repoql",
      "args": ["mcp"]
    }
  }
}
```

## Environment Variables

Sensitive values like API keys and tokens live in a `~/.secrets` file that gets sourced by my shell:

```bash
# ~/.secrets

# API Keys
export ERASER_API_KEY=your-eraser-api-key
export FIRECRAWL_API_KEY=your-firecrawl-key

# GitHub
export GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxxxx

# Grafana
export GRAFANA_URL=https://grafana.yourdomain.com
export GRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_xxxxx

# Prometheus
export PROMETHEUS_URL=https://prometheus.yourdomain.com

# Database MCP Config
export DB_CONFIGS='[{"id":"postgres","db_type":"pg","configuration":{"host":"10.x.x.x","port":5432,"user":"postgres","password":"yourpassword","dbname":"postgres"},"description":"CloudNative-PG"},{"id":"mariadb","db_type":"mysql","configuration":{"host":"10.x.x.x","port":3306,"user":"root","password":"yourpassword","database":"mysql"},"description":"MariaDB"}]'
```

Source this in your `.zshrc` or `.bashrc`:

```bash
[ -f ~/.secrets ] && source ~/.secrets
```

## Server-Specific Setup

### Grafana Service Account

Grafana MCP needs a service account token. Here's how to create one programmatically:

```bash
# Port-forward to Grafana
kubectl port-forward -n observability svc/grafana 3000:80 &

# Get admin credentials
kubectl get secret -n observability grafana-admin-secret -o jsonpath='{.data.GF_SECURITY_ADMIN_USER}' | base64 -d
kubectl get secret -n observability grafana-admin-secret -o jsonpath='{.data.GF_SECURITY_ADMIN_PASSWORD}' | base64 -d

# Create service account with Viewer role
curl -X POST http://localhost:3000/api/serviceaccounts \
  -H "Content-Type: application/json" \
  -u "admin:yourpassword" \
  -d '{"name": "mcp-grafana-reader", "role": "Viewer"}'

# Generate token (replace SERVICE_ACCOUNT_ID with the ID from above)
curl -X POST http://localhost:3000/api/serviceaccounts/SERVICE_ACCOUNT_ID/tokens \
  -H "Content-Type: application/json" \
  -u "admin:yourpassword" \
  -d '{"name": "mcp-token"}'
```

Save the token to your `~/.secrets` file.

### Eraser (Docker)

The Eraser MCP server isn't on npm, so I built it locally as a Docker container:

```bash
cd /home/<user>/mcp/eraser
docker build -t eraser-mcp:claude .
```

The config references this local image and passes the API key via environment variable.

### Databases

The `database-mcp` package expects a `DB_CONFIGS` environment variable containing JSON configuration. Important: it only supports `pg` (PostgreSQL), `mysql` (MariaDB/MySQL), `mssql`, `bigquery`, `oracle`, and `sqlite`. Redis/DragonflyDB are **not supported**.

## Testing Your Setup

After configuring everything, restart VS Code and check the MCP servers are loading. You can test individual servers:

```bash
# In Claude Code or VS Code with Claude extension
# Just ask Claude to use the tools:

"List all Flux Kustomizations"
"Query Prometheus for node memory usage"
"Show me the Grafana datasources"
"List tables in the postgres database"
```

If a server fails to load, check the VS Code Output panel (View → Output → select "Claude" from dropdown) for error messages.

---

## The Journey: Challenges and Fixes

What follows is the debugging saga. If you just wanted the guide, you're done — go forth and MCP. But if you're troubleshooting issues or just enjoy watching someone else suffer through config errors, read on.

### Grafana: 401 Unauthorized

**Symptom:** Grafana MCP failed with `401 Unauthorized`

**Cause:** No authentication configured. The MCP server needs either basic auth or a service account token.

**Fix:** Created a service account with Viewer role (see setup above). The token goes in `GRAFANA_SERVICE_ACCOUNT_TOKEN`.

### Talos: "No Talos configuration loaded"

**Symptom:** All Talos MCP tools returned "No Talos configuration loaded"

**Cause:** Bug in the Talos MCP server — it wasn't reading the `TALOSCONFIG` environment variable. The code instantiated `TalosClient()` without passing the config path.

**Fix:** Modified `/home/<user>/mcp/talos/src/talos_mcp/server.py` line 115:

```python
# Before
talos_client = TalosClient()

# After
talos_client = TalosClient(config_path=os.environ.get("TALOSCONFIG"))
```

I submitted a PR for this fix: https://github.com/ry-ops/talos-mcp-server/pull/1

### Databases: "Unsupported database type: redis"

**Symptom:** Database MCP failed to start entirely

**Cause:** I had DragonflyDB (Redis-compatible) in my `DB_CONFIGS` with `"db_type":"redis"`. The `database-mcp` package doesn't support Redis.

**Fix:** Removed the DragonflyDB entry from `DB_CONFIGS`. Only PostgreSQL and MariaDB remain.

### Databases: Environment Variable Expansion

**Symptom:** Database passwords weren't being used — connection failures

**Cause:** I had nested environment variables in `.mcp.json`:

```json
"DB_CONFIGS": "[{...\"password\":\"${CNPG_PASSWORD}\"...}]"
```

The shell doesn't expand `${CNPG_PASSWORD}` inside a JSON string inside an env var.

**Fix:** Moved the entire `DB_CONFIGS` JSON (with passwords pre-embedded) to `~/.secrets`. The `.mcp.json` just references `${DB_CONFIGS}` which expands to the full JSON.

### Mermaid: Package Name Change

**Symptom:** Mermaid MCP failed with "Connection closed"

**Cause:** Package moved from `@probelabs/maid mcp` to `@probelabs/maid-mcp`

**Fix:** Updated the args in `.mcp.json`:

```json
"args": ["-y", "@probelabs/maid-mcp"]
```

### Eraser: npm 404

**Symptom:** `npm error 404 Not Found - eraser-io-mcp-server`

**Cause:** The package `eraser-io-mcp-server` doesn't exist on npm. The only Eraser MCP is a GitHub repo that needs to be built locally.

**Fix:** Cloned the repo, built a Docker image, and configured MCP to run it via Docker:

```json
"eraser": {
  "command": "docker",
  "args": ["run", "-i", "--rm", "-e", "ERASER_API_KEY=${ERASER_API_KEY}", "eraser-mcp:claude"]
}
```

### Filesystem: Redundant

**Symptom:** Filesystem MCP showed "Failed to fetch tools"

**Cause:** The filesystem MCP requires allowed directories to be specified in args. Without them, it has no permissions and exposes no tools.

**Resolution:** Removed it entirely. The shell MCP already handles file operations via `cat`, `ls`, etc., plus gives access to kubectl/flux/talosctl. Filesystem MCP was redundant.

## Context Usage: The Cost of Power

One thing worth knowing: MCP tools consume tokens. Each tool definition takes up space in Claude's context window, and with 14 servers loaded, it adds up fast.

You can check your context usage anytime by running `/context` in Claude Code:

```
Context Usage
Model: claude-opus-4-5-20251101
Tokens: 199.6k / 200.0k (100%)

Categories
Category              Tokens    Percentage
System prompt         3.0k      1.5%
System tools          13.9k     6.9%
MCP tools             137.3k    68.7%
Memory files          460       0.2%
Messages              8         0.0%
Free space            375       0.2%
Autocompact buffer    45.0k     22.5%
```

Yeah, **137k tokens just for MCP tool definitions**. That's 68% of the context window before Claude even reads a single file or responds to a message.

Some of the heavier servers by token count:

| Server | Tools | ~Tokens |
|--------|-------|---------|
| grafana | 55 tools | ~42k |
| github | 42 tools | ~30k |
| flux | 17 tools | ~11k |
| kubernetes | 21 tools | ~14k |
| repoql | 3 tools | ~4.5k |
| firecrawl | 6 tools | ~8.5k |

If you're hitting context limits, consider disabling servers you don't actively need. The shell MCP alone (716 tokens) gives you kubectl/flux/talosctl access — you might not need the dedicated kubernetes MCP (14k tokens) for basic queries.

## Wrapping Up

14 MCP servers later, Claude can now:
- Check my Flux reconciliation status
- Query Prometheus metrics
- List Grafana dashboards and datasources
- Run SQL queries against my databases
- Create diagrams on Eraser.io
- Execute controlled shell commands
- Search and read GitHub repos

Is it overkill? Probably. Is it fun watching an AI debug my cluster at 2am while I drink coffee? Absolutely.

The config is in my [home-ops repo](https://github.com/gavinmcfall/home-ops) if you want to steal it.
