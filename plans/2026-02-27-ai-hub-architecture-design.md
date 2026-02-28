# AI Hub Architecture Design

**Date:** 2026-02-27
**Status:** Draft

## Overview

A self-hosted AI assistant platform running on a home server, orchestrated by OpenClaw, powered by local models via Ollama, accessible through Discord and a web dashboard, with automated workflows for email triage, summaries, and proactive alerts.

## Hardware

| Component | Spec |
|-----------|------|
| GPU | NVIDIA RTX 3090, 24 GB VRAM |
| CPU | AMD Ryzen 5900X (12C/24T) |
| RAM | 32 GB |
| Storage | 1 TB NVMe |
| OS | Arch Linux (minimal) |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        HOME SERVER                              │
│                                                                 │
│  ┌──────────────┐    ┌──────────────────────────────────────┐   │
│  │   Ollama      │    │         OpenClaw Gateway             │   │
│  │  (GPU models) │◄───│                                      │   │
│  │  :11434       │    │  ┌────────┐ ┌────────┐ ┌─────────┐  │   │
│  └──────────────┘    │  │ Coding  │ │ Chat   │ │ Email   │  │   │
│                      │  │ Agent   │ │ Agent  │ │ Agent   │  │   │
│                      │  └────────┘ └────────┘ └─────────┘  │   │
│                      │  ┌────────────┐ ┌─────────────────┐  │   │
│                      │  │ Cron/Auto  │ │ Session/Memory  │  │   │
│                      │  │ Scheduler  │ │ Store           │  │   │
│                      │  └────────────┘ └─────────────────┘  │   │
│                      │                                      │   │
│                      │  Control UI / Dashboard  :3007       │   │
│                      └──────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐                           │
│  │  Tailscale   │    │  Cloudflare  │                           │
│  │  (VPN mesh)  │    │  Tunnel      │                           │
│  └──────────────┘    └──────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
         │                      │
         ▼                      ▼
   Trusted devices         Custom domain
   (full access)        (dashboard only,
                      behind Cloudflare Access)

         Discord API ◄──── OpenClaw (outbound connection)
```

## Layer 1: NVIDIA Driver & GPU Stack

Arch Linux minimal install requires manual NVIDIA setup.

**Installation:**
```bash
sudo pacman -S nvidia nvidia-utils
```

- `nvidia` — proprietary driver (official Arch repos)
- `nvidia-utils` — CUDA runtime, required by Ollama
- `nvidia-settings` — GUI config tool, **skip** (requires a desktop environment)
- `nvtop` — TUI GPU monitor, useful headless replacement: `yay -S nvtop`

**Verification:**
```bash
nvidia-smi          # Should show RTX 3090, 24 GB VRAM
nvtop               # Live GPU utilization in terminal
```

## Layer 2: Local Model Inference — Ollama

Ollama serves models via an OpenAI-compatible API on `http://127.0.0.1:11434`.

### Model Tiers

Three model tiers optimized for the 24 GB VRAM budget:

#### Tier 1: Small & Fast (always-loaded default)

**Qwen3 30B-A3B** — Mixture-of-Experts (30B total, 3.3B active per token)

| Property | Value |
|----------|-------|
| Ollama | `ollama pull qwen3:30b-a3b` |
| VRAM | ~5-6 GB (only 3.3B params active during inference) |
| Speed | Very fast — 3B-class inference speed with 30B-class intelligence |
| Use for | Email categorization, quick chat, summaries, cron tasks, notifications |

The MoE architecture is the key advantage: 30B total parameters are split across expert networks, but only 3.3B activate per token. This gives much higher quality than a true 3B model while using comparable VRAM. This model stays resident in memory at all times.

#### Tier 2: Coding Specialist (on-demand)

**Qwen 2.5 Coder 32B** (Q4_K_M quantization)

| Property | Value |
|----------|-------|
| Ollama | `ollama pull qwen2.5-coder:32b` |
| VRAM | ~19-20 GB at Q4_K_M |
| Speed | ~15-20 tok/s on RTX 3090 |
| HumanEval | 92.7% (matches GPT-4o) |
| Use for | Code generation, refactoring, debugging, code review |

The consensus best local coding model. At Q4 quantization it fits in 24 GB with headroom. Loads on demand when coding tasks arrive; Ollama unloads the Tier 1 model and swaps this in (~5-10s cold start).

#### Tier 3: Large General Assistant (on-demand)

**GLM-4.7-Flash** (with reasoning mode)

| Property | Value |
|----------|-------|
| Ollama | `ollama pull glm-4.7-flash` |
| VRAM | ~15 GB at Q4 |
| Speed | 120-220 tok/s on comparable hardware |
| Intelligence Index | 30.1 (top of local model benchmarks) |
| Use for | Complex reasoning, multi-step analysis, planning, research |

Tops recent local model intelligence benchmarks. Use for tasks where the Tier 1 model isn't smart enough — complex analysis, nuanced reasoning, long-form generation.

### VRAM Management Strategy

```
VRAM Budget: 24 GB
─────────────────────────────────────────────────────
Always loaded:  Qwen3 30B-A3B        ~5 GB   (handles ~80% of tasks)
On demand:      Qwen 2.5 Coder 32B   ~20 GB  (swaps in for coding)
On demand:      GLM-4.7-Flash         ~15 GB  (swaps in for complex reasoning)
─────────────────────────────────────────────────────
Only ONE large model loaded at a time.
Ollama handles swapping automatically (~5-10s cold start).
```

Ollama manages model loading/unloading automatically. When a Tier 2 or Tier 3 model is requested, Ollama evicts the current large model (if any), loads the requested one, serves the request, and keeps it warm for subsequent requests. The Tier 1 model reloads quickly when needed again due to its small footprint.

### Ollama Configuration

```bash
# Ollama listens on localhost only (security)
OLLAMA_HOST=127.0.0.1:11434

# Limit VRAM usage to leave headroom for system
OLLAMA_MAX_VRAM=22  # GB, leave 2 GB for system

# Keep models loaded longer to reduce swapping for bursty usage
OLLAMA_KEEP_ALIVE=10m
```

### Installation

Ollama is not in the official Arch repos — install from the AUR. Use the CUDA variant for GPU support:

```bash
yay -S ollama-cuda
sudo systemctl enable --now ollama
```

The AUR package installs a pre-configured systemd service and creates the `ollama` user automatically. Override the service defaults via a drop-in rather than editing the unit file directly:

```bash
sudo systemctl edit ollama
```

### Ollama as a systemd Service

```ini
# /etc/systemd/system/ollama.service
[Unit]
Description=Ollama Model Server
After=network.target

[Service]
Type=simple
User=ollama
Group=ollama
Environment="OLLAMA_HOST=127.0.0.1:11434"
ExecStart=/usr/local/bin/ollama serve
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

## Layer 3: OpenClaw Gateway — The Orchestrator

OpenClaw is the central brain. It routes messages from Discord to agents, manages sessions, runs cron jobs, and provides the web dashboard.

### OpenClaw as the Model Provider Interface

OpenClaw connects to Ollama via its OpenAI-compatible API:

```json5
// ~/.openclaw/openclaw.json (model provider section)
{
  "models": {
    "providers": {
      "ollama-local": {
        "type": "openai-compatible",
        "baseUrl": "http://127.0.0.1:11434/v1",
        "models": {
          "qwen3:30b-a3b": {
            "contextWindow": 32768,
            "maxOutput": 4096
          },
          "qwen2.5-coder:32b": {
            "contextWindow": 32768,
            "maxOutput": 4096
          },
          "glm-4.7-flash": {
            "contextWindow": 32768,
            "maxOutput": 4096
          }
        }
      }
    }
  }
}
```

### Agent Architecture

Each use case gets a dedicated agent with its own system prompt, model, and tool access profile.

#### Coding Agent

- **Model:** `qwen2.5-coder:32b` (Tier 2 — loaded on demand)
- **Tools:** filesystem (rw), exec (sandboxed), git
- **Sandbox:** Docker container with workspace mount
- **Session:** persistent per-project, manual reset

#### Chat Agent

- **Model:** `glm-4.7-flash` for complex questions (Tier 3), `qwen3:30b-a3b` for casual chat (Tier 1)
- **Routing:** OpenClaw can be configured to use Tier 1 by default and escalate to Tier 3 when the conversation requires deeper reasoning
- **Tools:** web search (optional), memory
- **Sandbox:** none (no filesystem/exec needed)
- **Session:** per-sender, daily reset

#### Email Agent

- **Model:** `qwen3:30b-a3b` (Tier 1 — always loaded, fast for classification)
- **Tools:** Gmail API (via webhook/poll), notification dispatch
- **Sandbox:** none
- **Session:** isolated per run
- **Automation:** Cron job polls for new email, agent categorizes and flags action items

#### Workflow/Summary Agent

- **Model:** `qwen3:30b-a3b` (Tier 1 — always loaded, good at summarization)
- **Tools:** session read (cross-agent), notification dispatch
- **Sandbox:** none
- **Session:** isolated per run
- **Automation:** Daily cron produces summaries of all agent activity

### Agent Routing

OpenClaw routes messages to agents based on Discord channel or command prefix:

| Discord Channel / Trigger | Agent | Description |
|--------------------------|-------|-------------|
| `#coding` or `/code` | Coding Agent | Code assistance, file operations |
| `#general` or DM | Chat Agent | General conversation |
| `#email` or cron trigger | Email Agent | Email triage and categorization |
| `#summary` or cron trigger | Workflow Agent | Daily summaries, alerts |

### Cron Jobs

```bash
# Morning email triage (7:00 AM daily)
openclaw cron add --name "email-triage" \
  --cron "0 7 * * *" --tz "America/New_York" \
  --session isolated \
  --message "Check for new emails, categorize them, flag items needing response" \
  --announce --channel discord --to "channel:<email-channel-id>"

# Evening summary (9:00 PM daily)
openclaw cron add --name "daily-summary" \
  --cron "0 21 * * *" --tz "America/New_York" \
  --session isolated \
  --message "Summarize today's activity across all agents. List pending action items." \
  --announce --channel discord --to "channel:<summary-channel-id>"
```

### OpenClaw Security Configuration

```json5
// ~/.openclaw/openclaw.json (security section)
{
  "gateway": {
    "bind": "loopback",           // localhost only — no LAN exposure
    "auth": {
      "mode": "token",            // token-based auth for Control UI
    }
  },
  "dmPolicy": "pairing",          // unknown senders get pairing codes
  "channels": {
    "discord": {
      "requireMention": true,     // must @bot in guild channels
      "allowFrom": ["<your-discord-id>", "<trusted-user-ids>"]
    }
  },
  "sandbox": {
    "enabled": true,
    "provider": "docker",
    "defaultAccess": "none",      // agents get no filesystem by default
    "elevated": false             // no host exec escape hatch
  },
  "logging": {
    "redactPatterns": [
      "sk-[a-zA-Z0-9]+",         // API keys
      "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}"  // emails
    ]
  }
}
```

## Layer 4: Discord Integration

### Discord Server Structure

```
AI Hub (Discord Server)
├── #general        → Chat Agent (default)
├── #coding         → Coding Agent
├── #email          → Email Agent (cron announcements + manual queries)
├── #alerts         → Action items requiring your response
├── #daily-summary  → Automated daily summaries
└── #admin          → Bot status, errors, system notifications
```

### Discord Bot Setup

1. Create application at discord.com/developers
2. Enable privileged intents: Message Content (required), Server Members (recommended)
3. Generate bot token
4. Invite with scopes: `bot`, `applications.commands`
5. Permissions: Send Messages, Read Message History, Embed Links, Attach Files
6. Configure in OpenClaw: `openclaw config set channels.discord.token <token>`
7. Pair via DM pairing code

### Interaction Model

- **In channels:** Must @mention the bot (prevents accidental triggers)
- **In DMs:** Direct conversation, no mention needed
- **Slash commands:** `/code`, `/email`, `/summary` for explicit agent targeting
- **Reactions:** Bot reacts with status emoji (processing, done, error)

## Layer 5: Web Dashboard

OpenClaw ships a built-in Control UI and Dashboard accessible at the gateway port.

### What the Dashboard Provides

- **Session viewer:** See active and past conversations across all agents
- **Cron job management:** View, edit, run, and monitor scheduled tasks
- **Agent status:** Which agents are active, their current sessions
- **System health:** Model loading status, memory usage, errors

### Custom Dashboard Extension (Phase 2)

If OpenClaw's built-in dashboard doesn't meet the "alerts and action items" requirement, we extend it:

- **Event log:** OpenClaw webhook delivers agent events to a lightweight service
- **Action item tracker:** Email agent flags items → stored in SQLite → displayed in dashboard
- **Alert feed:** Aggregated from email triage, cron failures, and agent errors

This is deferred to Phase 2 — start with OpenClaw's built-in UI and evaluate gaps.

## Layer 6: Network & Remote Access

### Principle: Zero Open Ports

The home router exposes **nothing**. All remote access works through outbound-only connections.

### Tailscale — Private Network (Primary Access)

Tailscale creates an encrypted WireGuard mesh VPN between trusted devices.

**What it provides:**
- All services reachable from your phone/laptop when away from home
- Trusted people install Tailscale, you approve them on the admin console
- MagicDNS: access via `ai-hub.tailnet-name.ts.net`
- Free tier: 100 devices, 3 users

**What's accessible via Tailscale:**
- OpenClaw Control UI / Dashboard
- Ollama API (for direct model queries if needed)
- SSH (for server administration)
- Everything — this is the trusted network

**Installation & configuration:**
```bash
# Tailscale is in the official Arch repos
sudo pacman -S tailscale
sudo systemctl enable --now tailscaled
sudo tailscale up

# Enable MagicDNS and HTTPS (optional)
# Done via Tailscale admin console: https://login.tailscale.com/admin
```

### Cloudflare Tunnel — Custom Domain (Dashboard Access)

Cloudflare Tunnel exposes only the web dashboard on your custom domain, protected by Cloudflare Access.

**What it provides:**
- `https://hub.yourdomain.com` → OpenClaw Dashboard
- Cloudflare Access gate: requires email OTP or identity provider login
- DDoS protection, TLS termination by Cloudflare
- No ports open on your router

**What's accessible via Cloudflare Tunnel:**
- Web Dashboard only (single route)
- Nothing else — Ollama, SSH, etc. are NOT exposed

**Configuration:**
```bash
# cloudflared is in the AUR
yay -S cloudflared

# Authenticate
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create ai-hub

# Configure tunnel
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: <tunnel-id>
credentials-file: ~/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: hub.yourdomain.com
    service: http://localhost:3007  # OpenClaw dashboard port
  - service: http_status:404       # catch-all: deny everything else
EOF

# Route DNS
cloudflared tunnel route dns ai-hub hub.yourdomain.com

# Run as service
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

**Cloudflare Access (Zero Trust):**
1. Go to Cloudflare Zero Trust dashboard
2. Create an Access Application for `hub.yourdomain.com`
3. Policy: Allow emails `you@email.com`, `trusted-friend@email.com`
4. Authentication: One-time PIN via email (simplest) or connect an IdP

### Network Security Summary

| Service | Tailscale | Cloudflare Tunnel | LAN | Internet |
|---------|-----------|-------------------|-----|----------|
| OpenClaw Dashboard | Yes | Yes (with auth) | localhost | No |
| Ollama API | Yes | No | localhost | No |
| SSH | Yes | No | No | No |
| Discord Bot | N/A (outbound) | N/A (outbound) | N/A | Outbound only |

## Layer 7: System Security Hardening

### OS-Level Security

```bash
# Firewall: deny all inbound, allow outbound
sudo pacman -S ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw enable

# No ports opened — Tailscale and cloudflared work outbound

# SSH hardening (Tailscale access only)
# /etc/ssh/sshd_config
ListenAddress 100.64.0.0/10    # Tailscale CGNAT range only
PermitRootLogin no
PasswordAuthentication no       # key-only
MaxAuthTries 3

# File permissions for OpenClaw
chmod 700 ~/.openclaw
chmod 600 ~/.openclaw/openclaw.json
chmod 600 ~/.openclaw/secrets.json
```

### Docker for Agent Sandboxing

Coding agent and any agent with exec/filesystem access runs inside a Docker container.

```bash
sudo pacman -S docker
sudo systemctl enable --now docker

# Create unprivileged user for OpenClaw
sudo useradd -r -m -s /bin/nologin openclaw
sudo usermod -aG docker openclaw
```

### Secrets Management

- Discord bot token: stored in `~/.openclaw/secrets.json` (mode 600)
- Cloudflare tunnel credentials: `~/.cloudflared/<id>.json` (mode 600)
- No API keys for model providers (everything is local via Ollama)
- Future: if adding cloud model fallback, store API keys in OpenClaw's secrets store

### Monitoring

```bash
# GPU monitoring (headless-friendly)
nvidia-smi --query-gpu=utilization.gpu,memory.used,temperature.gpu --format=csv -l 60
nvtop                      # interactive TUI (yay -S nvtop)

# OpenClaw audit
openclaw security audit

# Systemd service health
systemctl status ollama openclaw cloudflared tailscaled
```

## Deployment Order

This is the recommended installation sequence:

### Phase 1: Foundation (Day 1)

1. Install NVIDIA drivers: `sudo pacman -S nvidia nvidia-utils` + `yay -S nvtop`
2. Install and configure Ollama (`yay -S ollama-cuda`), pull models:
   - `ollama pull qwen3:30b-a3b` (Tier 1 — small/fast default)
   - `ollama pull qwen2.5-coder:32b` (Tier 2 — coding)
   - `ollama pull glm-4.7-flash` (Tier 3 — general assistant)
3. Install Docker
4. Install and configure Tailscale
5. Verify GPU inference works: `ollama run qwen3:30b-a3b "Hello"`

### Phase 2: OpenClaw + Discord (Day 2)

1. Install OpenClaw
2. Configure Ollama as model provider
3. Create Discord server with channel structure
4. Set up Discord bot and pair with OpenClaw
5. Configure Chat Agent (simplest agent, validates the full stack)
6. Test end-to-end: Discord message → OpenClaw → Ollama → response

### Phase 3: Agents & Automation (Day 3-4)

1. Configure Coding Agent with sandbox
2. Configure Email Agent with Gmail polling
3. Set up cron jobs (email triage, daily summary)
4. Configure alert routing to `#alerts` Discord channel
5. Test all agent routing

### Phase 4: Remote Access & Dashboard (Day 5)

1. Install and configure cloudflared
2. Set up Cloudflare Access with email auth
3. Point custom domain at tunnel
4. Verify dashboard access from external network
5. Run `openclaw security audit` and harden any findings

### Phase 5: Refinement (Ongoing)

1. Tune system prompts for each agent based on real usage
2. Evaluate if built-in dashboard meets needs; plan custom extension if not
3. Add model failover to cloud provider if local quality is insufficient for specific tasks
4. Explore additional automations (calendar, RSS, notifications)

## Open Questions

1. **Gmail integration method:** OpenClaw supports Gmail PubSub webhooks. Need to set up a Google Cloud project with Gmail API access. Alternative: IMAP polling via a custom script feeding into OpenClaw webhooks.
2. **Cloud fallback:** Consider adding an Anthropic or OpenAI API key as a fallback provider for tasks where local model quality isn't sufficient. OpenClaw supports model failover natively.
3. **Custom dashboard (Phase 2):** Evaluate OpenClaw's built-in Control UI before deciding whether a custom dashboard is needed. If needed, tech stack TBD (likely a lightweight framework served alongside OpenClaw).
4. **Model evolution:** The local model landscape changes rapidly. Re-evaluate model choices quarterly — newer models may offer better quality at the same VRAM budget. The three-tier architecture makes swapping models straightforward (just change the Ollama model name in OpenClaw config).

## Cost

| Item | Cost |
|------|------|
| Hardware | Already owned |
| Ollama | Free, open source |
| OpenClaw | Free, open source (MIT) |
| Tailscale | Free tier (100 devices, 3 users) |
| Cloudflare | Free tier (tunnel + Access for up to 50 users) |
| Domain | ~$10-15/year (if not already owned) |
| Discord | Free |
| **Total** | **~$0-15/year** |
