# OpenClaw Replacement Design

**Date:** 2026-02-28
**Status:** Approved
**Replaces:** Layer 3 (OpenClaw Gateway) from `2026-02-27-ai-hub-architecture-design.md`

## Context

OpenClaw has compatibility issues on Arch Linux. This document describes its replacement: a composed stack of Open WebUI (web dashboard) and a custom Node.js/TypeScript hub service (Discord bot, scheduling, email).

---

## Architecture Overview

```
Discord API  ←──(WebSocket gateway)──→  AI Hub Service  (Node.js, systemd, openclaw user)
                                              │
                                    ┌─────────┼──────────────┐
                                    │         │              │
                                discord.js  node-cron    imapflow
                                (routing,   (cron jobs)  (IMAP email)
                                 security)
                                    │         │
                                    └────┬────┘
                                         │ HTTP (OpenAI-compatible)
                                         ▼
                               Ollama  127.0.0.1:11434

                               Open WebUI  (Docker, 127.0.0.1:3000)
                               └── Web dashboard — also talks to Ollama directly

                               Cloudflare Tunnel → hub.yourdomain.com
                               └── Points to Open WebUI :3000

                               Tailscale → all services (trusted device access)
```

**Key principles:**
- Hub service calls Ollama **directly** — no runtime dependency on Open WebUI
- Open WebUI is the **Cloudflare Tunnel target** (dashboard), not an inference proxy
- Both services talk to Ollama independently; either can restart without affecting the other
- Hub runs under the existing `openclaw` system user

---

## Component 1: Open WebUI

**Role:** Web dashboard, session history, model management. The thing exposed via Cloudflare Tunnel.

**Deployment:** Docker Compose, managed by a systemd service.

```yaml
# /opt/ai-hub/docker-compose.yml
services:
  open-webui:
    image: ghcr.io/open-webui/open-webui:main
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:8080"   # localhost only — not LAN-exposed
    environment:
      - OLLAMA_BASE_URL=http://host.docker.internal:11434
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - open-webui:/app/backend/data

volumes:
  open-webui:
```

Cloudflare Tunnel points to `http://localhost:3000` (replaces original `:3007` target — everything else in Phase 4 is unchanged).

---

## Component 2: AI Hub Service (Node.js/TypeScript)

**Role:** Discord bot, cron scheduling, IMAP email triage, Ollama inference calls.

**Runtime:** Node.js with TypeScript. Built with `tsc`, run via systemd as `node dist/index.js`.

### Dependencies

| Package | Role |
|---|---|
| `discord.js` v14 | Discord gateway + API |
| `node-cron` | Cron scheduling |
| `imapflow` | IMAP email access |
| `openai` | Ollama OpenAI-compatible API client |
| `better-sqlite3` | State tracking (IMAP UIDs) |
| `smol-toml` | Config file parsing |

### Discord Routing

| Channel | Model | Notes |
|---|---|---|
| `#general`, DMs | `qwen3:30b-a3b` | Default; casual chat and general questions |
| `#coding` | `qwen2.5-coder:32b` | Coding specialist; Docker sandbox for exec |
| `/think` prefix (any channel) | `glm-4.7-flash` | Explicit escalation to deep reasoning |
| `#email`, `#alerts`, `#daily-summary` | Bot posts only | Users do not chat in these channels |

- **Guild channels:** `@mention` required; ignored otherwise
- **DMs:** responds directly, no mention needed
- **Security:** allowlist of Discord user IDs; all others silently ignored

### Cron Jobs

| Job | Schedule | Timezone | Action |
|---|---|---|---|
| `email-triage` | `0 7 * * *` | America/New_York | Fetch unseen IMAP emails → Ollama → post to `#email` / `#alerts` |
| `daily-summary` | `0 21 * * *` | America/New_York | Summarize day's Discord activity → post to `#daily-summary` |

Jobs are plain async functions — triggerable manually for testing.

### IMAP Email Integration

Supports multiple accounts via `imapflow`. Config uses TOML array of tables:

```toml
[[email.accounts]]
name = "gmail"
host = "imap.gmail.com"
port = 993
username = "user@gmail.com"
password_env = "GMAIL_APP_PASSWORD"
ssl = true
folders = ["INBOX"]

[[email.accounts]]
name = "outlook"
host = "outlook.office365.com"
port = 993
username = "user@outlook.com"
password_env = "OUTLOOK_PASSWORD"
ssl = true
folders = ["INBOX"]

[[email.accounts]]
name = "fastmail"
host = "imap.fastmail.com"
port = 993
username = "user@fastmail.com"
password_env = "FASTMAIL_APP_PASSWORD"
ssl = true
folders = ["INBOX"]
```

- Passwords loaded from environment variables (systemd `EnvironmentFile`), never from config
- Last-seen UID tracked per account in SQLite (`~/.local/share/ai-hub/state.db`) — reliable across restarts, no duplicate processing
- Per-account failure isolation: one failing account does not block others

### Coding Agent Sandbox

For messages in `#coding` that request code execution:
- Hub spawns a Docker container with a temp workspace directory mounted
- `--network none` — no network access inside container
- `--rm` — container removed after session ends
- Output streamed back to Discord

### Full Config Structure

```toml
[discord]
token_env = "DISCORD_TOKEN"
allowed_user_ids = [123456789]
guild_id = 987654321

[models]
default = "qwen3:30b-a3b"
coding  = "qwen2.5-coder:32b"
complex = "glm-4.7-flash"
ollama_base_url = "http://127.0.0.1:11434/v1"

[schedule]
timezone = "America/New_York"
email_triage_cron  = "0 7 * * *"
daily_summary_cron = "0 21 * * *"

[[email.accounts]]
# ... (see above)
```

---

## Security Model

### Discord
- Allowlist of user IDs in config; all others silently ignored
- `@mention` required in guild channels
- Bot token in systemd `EnvironmentFile` at mode 600

### Email Credentials
- One env var per account password in `/etc/ai-hub/hub.env` (mode 600, owned by `openclaw`)
- IMAP always SSL, port 993
- No plaintext credentials on disk

### Hub Service Process
- Runs as `openclaw` system user (no login shell)
- `openclaw` already in `docker` group (Phase 1) — sufficient to spawn sandbox containers
- Systemd unit hardening: `NoNewPrivileges=yes`, `PrivateTmp=yes`

### Coding Sandbox
- `--network none` — no outbound network from container
- Only the session workspace directory is mounted
- Container removed on session end (`--rm`)

### Secrets Summary

| Secret | Location | Mode |
|---|---|---|
| Discord bot token | `/etc/ai-hub/hub.env` | 600, `openclaw` |
| IMAP passwords | `/etc/ai-hub/hub.env` | 600, `openclaw` |
| Cloudflare tunnel credentials | `~/.cloudflared/<id>.json` | 600 |
| IMAP UID state | `~/.local/share/ai-hub/state.db` | 640, `openclaw` |

---

## Error Handling

| Failure | Behavior |
|---|---|
| Ollama unreachable | Bot replies `"⚠️ Model unavailable, try again in a moment."` in same channel |
| Coding sandbox fails to start | Bot replies with error category; full error in systemd journal |
| Cron job fails (any reason) | Posts brief notice to `#admin`; journal has full trace |
| One IMAP account fails | Others still run; `#admin` notified with account name (no credentials) |
| `#admin` unreachable | Errors go to journal only |
| Hub process crashes | `Restart=on-failure`, `RestartSec=10` in systemd unit |

**Intentionally not handled by the hub:**
- Model quality / hallucination (Ollama's domain)
- Discord rate limits (`discord.js` handles internally)
- VRAM exhaustion (Ollama handles model swapping)

---

## Network Access Matrix

| Service | Tailscale | Cloudflare Tunnel | localhost | LAN/Internet |
|---|---|---|---|---|
| Open WebUI (dashboard) | Yes | Yes (+ Cloudflare Access) | Yes | No |
| Ollama API | Yes | No | Yes | No |
| SSH | Yes | No | No | No |
| Discord bot | N/A — outbound only | N/A | N/A | Outbound only |
| IMAP (email) | N/A — outbound only | N/A | N/A | Outbound only |

---

## What Changes vs. Original Architecture

| Aspect | Original (OpenClaw) | This Design |
|---|---|---|
| Orchestrator | OpenClaw binary | Node.js/TypeScript service |
| Web dashboard | OpenClaw Control UI `:3007` | Open WebUI `:3000` |
| Discord integration | OpenClaw built-in | `discord.js` in hub service |
| Scheduling | `openclaw cron add` | `node-cron` in hub service |
| Email | Gmail PubSub or IMAP | IMAP only (`imapflow`), multi-account |
| Config | `openclaw.json` | `config.toml` + env file |
| Cloudflare Tunnel target | `:3007` | `:3000` |

Phases 1, 4, and 5 of the original plan are **unchanged**. Phase 2 (OpenClaw + Discord) and Phase 3 (Agents + Automation) are replaced by this design.
