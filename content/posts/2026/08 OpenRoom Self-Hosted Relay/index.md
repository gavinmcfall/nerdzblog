---
title: "OpenRoom, Self-Hosted: A Private Backchannel for My Claude Code Sessions"
description: "A friend dropped me a link to openroom.channel — a no-accounts protocol for AI agents to coordinate across machines. I wanted it, but I wanted it private. This is the trail from 'what is this' to a $0 Cloudflare relay on my own domain, plus the slash command that lets any running Claude session join a room without a restart."
date: 2026-05-30
slug: "2026/openroom-self-hosted-relay"
toc: true
math: false
draft: true
Tags:
  - OpenRoom
  - Cloudflare
  - Workers
  - Durable Objects
  - WebSockets
  - Claude Code
  - MCP
  - AI Agents
  - Self-Hosting
Categories: [AI, Self-Hosting]
---

> Someone sent me a single URL — `https://openroom.channel/` — and asked if I could help them understand it and maybe set it up. Three hours later I had a private copy running on my own domain for nothing, a slash command to drive it, and two Claude sessions talking to each other through it. Here's the whole trail, gotchas included.

## What OpenRoom actually is

[OpenRoom](https://openroom.channel/) is, in its own words, *"a protocol and CLI for agents to coordinate across machines, runtimes, and operators — without accounts."* Think of it as a public chat backbone for AI agents, with humans able to watch.

The design principles are the interesting part:

- **The room name is the only secret.** Anyone who knows a room's name can join it. No signup, no API key, no registration.
- **Observable by default.** Public rooms are readable by anyone via the viewer at openroom.channel. Even "direct messages" are *broadcast* to everyone in the room — hidden side-channels are deliberately impossible. The stated goal is that multi-agent coordination *failures* happen in the open, where researchers can study them.
- **Cryptographic identity, not accounts.** Each session uses an Ed25519 keypair; your public key is your identity across reconnects.
- **Dumb relay, smart types.** The server just routes signed messages and verifies signatures. The reference relay runs on Cloudflare Workers + Durable Objects at `wss://relay.openroom.channel`.

The piece that made me sit up: `openroom claude <room>` spawns a Claude Code session with the OpenRoom MCP server wired in, so multiple Claude sessions — on different machines, or belonging to different people — can talk to each other in a shared room. Given how many parallel Claude sessions I run, that's genuinely useful.

But "observable by default" and "public directory" set off the instinct that drives half of everything on this blog: *can I host it myself so it stays private?*

## Can it be self-hosted? Yes — two ways

The relay is open source ([dhruvyad/openroom](https://github.com/dhruvyad/openroom)) and the CLI points at any relay via one environment variable:

```bash
OPENROOM_RELAY=wss://relay.yourdomain   # default is wss://relay.openroom.channel
```

So traffic never has to touch openroom.channel. Their public directory never learns your rooms exist unless you explicitly publish them with `--public` — so you just don't.

Reading the repo, there are two self-host paths, and they share the *exact same protocol core* (`RelayCore`). They differ only in the operational shell around it:

| Capability | Cloudflare Worker | Node server (`ws`) |
|---|---|---|
| Protocol, signatures, topics, capabilities, DMs | ✅ | ✅ (same core) |
| **Durable persistence** (survives a restart) | ✅ Durable Object SQLite storage | ❌ in-memory only |
| Per-room isolation | ✅ one DO per room | ❌ single shared process |
| Idle hibernation / scale-to-zero | ✅ WebSocket Hibernation | ❌ always on |
| Public directory | ✅ | ❌ not implemented |

The Node build isn't a toy — it's the full wire protocol — but it's a stripped *envelope*: no persistence, no directory, single process. The verdict that decided it for me: I wanted the option to run a room **persistently for days**, and that's exactly where the Node path is weakest (a pod restart vaporises every room and its history). On Cloudflare, a long-lived room mostly idle is the *ideal* workload — it hibernates for free and rehydrates on the next message.

## The honest privacy caveat

Self-hosting buys you **infrastructure privacy** (traffic on your own box) and **discoverability privacy** (rooms only findable by someone who knows your relay URL *and* the room name). It does **not** buy you confidentiality:

> There's no end-to-end encryption anywhere. The relay sees plaintext, and "direct messages" are broadcast to the whole room by design.

So a self-hosted room is a *private venue, open mic inside*. Fine for coordinating my own agents. Not a place to put secrets. I went in clear-eyed about that.

## Cost: I expected $5/month, I got $0

I assumed Durable Objects meant the Workers Paid plan ($5/mo floor). I was wrong, and I'm glad I checked the current docs instead of trusting memory — this changed recently.

The relay's `wrangler.jsonc` declares **SQLite-backed** Durable Objects (`new_sqlite_classes`). And per Cloudflare's own pricing page:

> Workers Free plan can only create and access SQLite-backed Durable Objects.

Plus, from the [December 2025 SQLite-storage billing changelog](https://developers.cloudflare.com/changelog/post/2025-12-12-durable-objects-sqlite-storage-billing/):

> Developers on the Workers Free plan will not be charged.

Free-plan compute limits are 100,000 requests/day and 13,000 GB-s duration/day. A handful of rooms with a few agents doesn't come close — and because the relay uses WebSocket Hibernation, idle rooms burn essentially zero duration. **Realistic bill for personal multi-agent coordination: $0.** The custom domain on a zone I already own is free too.

> **Lesson worth repeating:** vendor pricing and free-tier rules change. Verify against live docs before you quote a number — especially for anything as fast-moving as the serverless platforms.

## Deploying the relay

I already own `nerdz.cloud` on Cloudflare, so the plan was: deploy the relay Worker to that account, on `openroom.nerdz.cloud`, on the Free plan.

It's a pnpm monorepo, so the first step is a workspace install (the relay depends on the SDK via `workspace:*`):

```bash
git clone https://github.com/dhruvyad/openroom.git
cd openroom
pnpm install
```

Two snags here, both quick:

- pnpm now blocks build scripts by default, so the first `pnpm install` failed mid-way on the SDK's `prepare` step with a `tsc: Permission denied` from the pnpm `.bin` shim. Re-running the install — once the shim existed — built the SDK cleanly. (Confirming `node node_modules/typescript/bin/tsc --version` ran fine told me it wasn't a real toolchain problem.)
- My git-safety hook quite correctly blocked a `git clone` script that began `rm -rf` an old directory. Good. I cloned to a fresh path instead of arguing with it.

Then point the custom domain at my subdomain. The only edit to `wrangler.jsonc`:

```jsonc
"routes": [
    {
        "pattern": "openroom.nerdz.cloud",
        "custom_domain": true
    }
],
```

And deploy with the account-scoped token (I keep one per Cloudflare account so I never deploy to the wrong one):

```bash
source ~/.secrets
export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN_NERDZ"
export CLOUDFLARE_ACCOUNT_ID="<nerdz-account-id>"
pnpm --filter openroom-relay run deploy
```

```
Uploaded openroom-relay (1.59 sec)
Deployed openroom-relay triggers (1.89 sec)
  https://openroom-relay.nerdz.workers.dev
  openroom.nerdz.cloud (custom domain)
```

The custom domain's DNS record and TLS cert provisioned almost instantly. Health check passed first try:

```bash
$ curl -s https://openroom.nerdz.cloud/health
{"service":"openroom-relay","protocol":"openroom/1","status":"ok"}
```

A two-terminal smoke test (`openroom listen` in one, `openroom send` in the other, both with `OPENROOM_RELAY=wss://openroom.nerdz.cloud`) confirmed a message round-tripped through *my* relay. The infrastructure was done. The interesting design problem was still ahead.

## The wrinkle: MCP servers load at startup only

What I really wanted was simple: a slash command I could run **from any session I'm already in** to join a room — not a command that spawns a *new* Claude session, which is what `openroom claude <room>` does.

That ran straight into a hard constraint of Claude Code, which I verified rather than assumed:

> Claude Code loads MCP servers only at session startup. There is no mid-session hot-load, and `/mcp` only manages OAuth and status — it cannot reconnect a newly-registered server.

So "register the OpenRoom MCP server and have *this running session* use its tools" is genuinely impossible without a restart or resume. The MCP route is real and gives the agent native tools (`send_message`, `list_agents`, `create_topic`, …), but it's inherently a *fresh-session* thing.

## The fix: drive the CLI from a slash command

The CLI doesn't care about session startup. So the slash command sidesteps MCP entirely: it starts a background `openroom listen` (so the current session *receives*), and sends with `openroom send` on demand. Same practical outcome — present in the room, sending and receiving — with no restart.

### How Claude Code custom commands work

A custom slash command in Claude Code is just a Markdown file under `~/.claude/commands/` (user-wide) or `.claude/commands/` (per-project). The filename is the command name — `openroom.md` becomes `/openroom`. YAML frontmatter configures it; the body is a prompt the agent follows when you invoke it, with `$ARGUMENTS` substituted for whatever you typed after the command.

One pleasant detail: new command files are picked up **live** — as long as the `~/.claude/commands/` directory already existed when the session started, a freshly-created `/openroom` is usable immediately, no restart.

Here's `~/.claude/commands/openroom.md`, trimmed to the essentials:

```markdown
---
description: Join a room on my self-hosted OpenRoom relay from THIS session
argument-hint: <room-name> [message to send immediately]
allowed-tools: Bash, Read
---

Join the OpenRoom room named in the first argument on wss://openroom.nerdz.cloud,
so THIS session receives messages. The first token of `$ARGUMENTS` is the room;
anything after it is a message to send immediately.

1. Start the listener as a BACKGROUND task (run_in_background): `openroom-room join "<room>"`
2. Read the task's output file to confirm the join banner.
3. If a message was supplied, send it: `openroom send "<room>" "<text>"`

For the rest of the session: send with `openroom send`, check for new messages by
reading the listener's output file, and leave with `openroom-room leave "<room>"`.
```

`allowed-tools` is what lets the command run `Bash`/`Read` without re-prompting each time. Notice it doesn't call `openroom listen` directly — it goes through a small helper, `openroom-room`, which is where the interesting bit lives.

### The helper: session-scoped join and leave

My first cut of "leave the room" was a lazy `pkill -f "openroom listen"`. That's a landmine: I run *many* Claude sessions at once, and that command would terminate **every** session's listener on the box, not just the one I'm in. The fix is to never pattern-match the process table — instead, track the exact PID *this* session starts, and kill only that.

The lever is `CLAUDE_CODE_SESSION_ID`, an environment variable Claude Code exports into every shell it runs, unique per session. The helper keys a per-session state directory off it. `~/.local/bin/openroom-room`, with the load-bearing parts:

```bash
#!/usr/bin/env bash
set -euo pipefail
SID="${CLAUDE_CODE_SESSION_ID:-nosession}"
STATE_DIR="${HOME}/.openroom/sessions/${SID}"

cmd_join() {                       # run via Claude's run_in_background
    local room="$1"; mkdir -p "$STATE_DIR"
    # Record THIS process's PID, then *exec* the listener so the recorded
    # PID literally BECOMES the listener — race-free, no $! bookkeeping.
    echo "$$" > "${STATE_DIR}/${room}.pid"
    export OPENROOM_RELAY="${OPENROOM_RELAY:-wss://openroom.nerdz.cloud}"
    exec openroom listen "$room"
}

cmd_leave() {                      # leave one room, or (no arg) all this session's rooms
    local pid; pid="$(cat "${STATE_DIR}/${1}.pid" 2>/dev/null)"
    # Only kill if it's still alive AND still an openroom listener — guards
    # against the PID having been recycled for some unrelated process.
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null \
        && tr '\0' ' ' < "/proc/${pid}/cmdline" | grep -qE 'openroom|listen'; then
        kill "$pid"                # SIGTERM → clean WebSocket close
    fi
    rm -f "${STATE_DIR}/${1}.pid"
}
```

Two design choices carry the whole thing:

- **`exec` makes the recorded PID the listener.** No `$!`, no `wait`, no race — the shell process *is* the listener after `exec`, and that's the PID we wrote down.
- **Kill by recorded PID, never by name.** A second `/openroom-leave` command (`~/.claude/commands/openroom-leave.md`) just calls `openroom-room leave $ARGUMENTS`. Because it only ever consults *this* session's state directory, it physically cannot touch another session's listeners.

And SIGTERM (plain `kill`) closes the WebSocket cleanly, so everyone else in the room just sees a normal "agent left" tick — not a yanked connection.

## The test: two sessions, one room

I ran `/openroom test-room` in this session. The listener came up:

```
╭ listening ─────────────────────────────╮
│  room      test-room                   │
│  relay     wss://openroom.nerdz.cloud  │
│  identity  qM7j-iDY                    │
╰────────────────────────────────────────╯
```

Then I opened a second, completely separate Claude session and ran `/openroom test-room` there too. The first session's feed ticked up as the second joined:

```
16:55:32 + 2 agents in room
16:56:26 + 3 agents in room
```

Sent a message from session A, replied from session B, and watched both land:

```
16:56:59 <- 1sDHwjiz #main hello from session A — if you can read this, the round-trip works
16:57:39 <- 98t-w4FR #main hello from session B — round-trip confirmed, I can read you loud and clear
```

Round-trip confirmed both directions, entirely on my own relay.

One quirk to explain if you try this: the "agents in room" count flickers (`+4`, then `-3`) around each message. That's expected — every `openroom send` opens a brief throwaway connection to deliver the message and then disconnects. The persistent *listeners* stay put; only the senders blink in and out.

## Proving the clean disconnect

The whole point of the session-scoped helper is that leaving one session never disturbs another. To prove it, I had two "sessions" join the **same** room and then left from one.

I didn't spin up a second real Claude session for this — I faked one in the same shell by overriding the session-id variable, which is exactly what a genuinely separate session would present to the helper:

```bash
# our session
openroom-room join disc-test                              # records under .../sessions/<real-id>/
# a stand-in for a different session, same room
CLAUDE_CODE_SESSION_ID=other-sess-9999 openroom-room join disc-test
```

Both listeners came up with distinct PIDs under separate state directories. Then I left from our session only:

```bash
$ openroom-room leave disc-test
left 'disc-test' (pid 122584, SIGTERM — clean socket close)
```

| Listener | PID | After our `leave` |
|---|---|---|
| Our session | 122584 | gone |
| Other session (same room) | 122851 | **still alive, untouched** |

Exactly the property I wanted: the leave reached into one session's state directory, killed one tracked PID, and left the co-tenant in the same room completely alone. No `pkill`, no collateral.

## Where this leaves me

- A private OpenRoom relay on `openroom.nerdz.cloud`, on Cloudflare's Free plan, costing nothing at my scale.
- A `/openroom <room>` slash command that drops any running Claude session into a shared room without a restart.
- A `/openroom-leave` companion that disconnects cleanly and only ever touches the session it's run from — safe to use with a dozen sessions open.
- A clear-eyed understanding that this is a private venue, not an encrypted one.

The obvious next step is a browser watch-UI for my own rooms. The hosted viewer at openroom.channel is hard-wired to *their* relay, so it can't see mine — but the web app is in the same repo and takes a build-time `NEXT_PUBLIC_OPENROOM_RELAY`, so a second tiny Cloudflare deploy would give me a read-only window into my own rooms. That's a job for another evening.

What I like most about this one: it's a complete arc in a few hours — understand a thing, decide I want it on my own terms, read enough source to make a real decision, verify the costs instead of guessing, and ship something I'll actually use. The kind of self-hosting that pays for itself in understanding alone.
