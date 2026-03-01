# AI Hub Architecture

**Date:** 2026-02-28
**Status:** Current

## Overview

A self-hosted AI assistant platform running on a home server. Powered by local models via Ollama, accessible through Discord and a web dashboard, with automated workflows for email triage, summaries, and proactive alerts.

The orchestration layer is a custom Node.js/TypeScript service (the "hub") that handles Discord routing, IMAP email triage, and cron scheduling. The web dashboard is Open WebUI running in Docker.

---

## Repository Structure

All source code and plans live in this repo (`~/ai-hub`). Deployment scripts copy build artifacts and config to the runtime location.

```
~/ai-hub/
├── plans/                        # Planning documents
│   ├── 2026-02-28-ai-hub-architecture.md  # This file
│   └── tasks.md
├── hub/                          # Node.js/TypeScript hub service (source)
│   ├── src/
│   ├── tests/
│   ├── Dockerfile                # Multi-stage build
│   ├── package.json
│   └── tsconfig.json
├── deploy/
│   ├── docker-compose.yml        # Both services: ai-hub + open-webui
│   ├── config.toml.example       # Config template (safe to commit)
│   ├── deploy.sh                 # Build images & sync config to /opt/ai-hub
│   └── install-systemd.sh        # Install systemd unit (run once)
└── systemd/
    └── ai-hub.service            # Manages the whole compose stack
```

**Runtime location:** `/opt/ai-hub/` — compose file, config, and volumes only. No compiled artifacts on the host filesystem; everything runs inside containers.

```
/opt/ai-hub/
├── docker-compose.yml  # Copied from repo on deploy
└── config.toml         # Live config (not in repo — contains IDs/secrets)
```

Docker volumes (managed by compose, not on host filesystem):
- `open-webui` — Open WebUI session/model data
- `hub-state` — SQLite IMAP UID state

**Secrets** are never in the repo. They live in `/etc/ai-hub/hub.env` (mode 600, owned by root/openclaw).

---

## Hardware

| Component | Spec |
|-----------|------|
| GPU | NVIDIA RTX 3090, 24 GB VRAM |
| CPU | AMD Ryzen 5900X (12C/24T) |
| RAM | 32 GB |
| Storage | 1 TB NVMe |
| OS | Arch Linux (minimal) |

---

## Architecture

```
Discord API  ←──(WebSocket)──→  AI Hub Service  (Node.js, systemd, openclaw user)
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

                       Cloudflare Tunnel → hub.yourdomain.com → :3000
                       Tailscale → all services (trusted device access)
```

**Key principles:**
- Hub service calls Ollama directly — no runtime dependency on Open WebUI
- Open WebUI is the Cloudflare Tunnel target (dashboard), not an inference proxy
- Both services talk to Ollama independently; either can restart without affecting the other
- Hub runs under the `openclaw` system user (created in Phase 1)

---

## Layer 1: NVIDIA Driver & GPU Stack

Arch Linux minimal install requires manual NVIDIA setup.

```bash
sudo pacman -S nvidia nvidia-utils
yay -S nvtop
```

**Verification:**
```bash
nvidia-smi          # Should show RTX 3090, 24 GB VRAM
nvtop               # Live GPU utilization in terminal
```

---

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
| Use for | Email triage, quick chat, summaries, cron tasks, notifications |

#### Tier 2: Coding Specialist (on-demand)

**Qwen 2.5 Coder 32B** (Q4_K_M quantization)

| Property | Value |
|----------|-------|
| Ollama | `ollama pull qwen2.5-coder:32b` |
| VRAM | ~19-20 GB at Q4_K_M |
| Speed | ~15-20 tok/s on RTX 3090 |
| Use for | Code generation, refactoring, debugging, code review |

#### Tier 3: Large General Assistant (on-demand, `/think` prefix)

**GLM-4.7-Flash** (with reasoning mode)

| Property | Value |
|----------|-------|
| Ollama | `ollama pull glm-4.7-flash` |
| VRAM | ~15 GB at Q4 |
| Speed | 120-220 tok/s on comparable hardware |
| Use for | Complex reasoning, multi-step analysis, planning, research |

### VRAM Management

```
VRAM Budget: 24 GB
─────────────────────────────────────────────────────
Always loaded:  Qwen3 30B-A3B        ~5 GB   (handles ~80% of tasks)
On demand:      Qwen 2.5 Coder 32B   ~20 GB  (swaps in for coding)
On demand:      GLM-4.7-Flash        ~15 GB  (swaps in for /think)
─────────────────────────────────────────────────────
Only ONE large model loaded at a time.
Ollama handles swapping automatically (~5-10s cold start).
```

### Ollama Configuration (systemd drop-in)

```ini
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_MAX_VRAM=22"
Environment="OLLAMA_KEEP_ALIVE=10m"
```

---

## Layer 3: AI Hub Service (Node.js/TypeScript)

**Role:** Discord bot, cron scheduling, IMAP email triage, Ollama inference calls.

**Source:** `~/ai-hub/hub/` (this repo)
**Runtime:** Docker container built from `hub/Dockerfile`, managed by docker compose.

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
| `#coding` | `qwen2.5-coder:32b` | Coding specialist |
| `/think` prefix (any channel) | `glm-4.7-flash` | Explicit escalation to deep reasoning |
| `#email`, `#alerts`, `#daily-summary`, `#admin` | Bot posts only | Users do not chat in these channels |

- **Guild channels:** `@mention` required; ignored otherwise
- **DMs:** responds directly, no mention needed
- **Security:** allowlist of Discord user IDs; all others silently ignored

### Cron Jobs

| Job | Schedule | Timezone | Action |
|---|---|---|---|
| `email-triage` | `0 7 * * *` | America/New_York | Fetch unseen IMAP emails → Ollama → post to `#email` / `#alerts` |
| `daily-summary` | `0 21 * * *` | America/New_York | Summarize day's Discord activity → post to `#daily-summary` |

### Config Structure

**`/opt/ai-hub/config.toml`** (runtime, not in repo — copy from `deploy/config.toml.example`):
```toml
[discord]
token_env = "DISCORD_TOKEN"
allowed_user_ids = ["YOUR_DISCORD_USER_ID"]
guild_id = "YOUR_GUILD_ID"

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
name = "gmail"
host = "imap.gmail.com"
port = 993
username = "you@gmail.com"
password_env = "GMAIL_APP_PASSWORD"
ssl = true
folders = ["INBOX"]
```

**Secrets** go in `/etc/ai-hub/hub.env` (mode 600, owned by `openclaw`):
```ini
DISCORD_TOKEN=...
GMAIL_APP_PASSWORD=...
```

### Systemd Unit

Both services (hub + Open WebUI) are managed by a single compose stack via one systemd unit:

```ini
[Unit]
Description=AI Hub (Docker Compose stack)
After=docker.service ollama.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/ai-hub
ExecStart=/usr/bin/docker compose up
ExecStop=/usr/bin/docker compose down
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Restart a single service without touching the other:
```bash
docker compose -f /opt/ai-hub/docker-compose.yml restart ai-hub
```

### IMAP State Tracking

Last-seen UID tracked per account in SQLite (`/var/lib/ai-hub/state.db`) — reliable across restarts, no duplicate processing. Per-account failure isolation: one failing account does not block others.

### Error Handling

| Failure | Behavior |
|---|---|
| Ollama unreachable | Bot replies `⚠️ Model unavailable, try again in a moment.` |
| Cron job fails | Posts brief notice to `#admin`; journal has full trace |
| One IMAP account fails | Others still run; `#admin` notified with account name |
| Hub process crashes | `Restart=on-failure`, `RestartSec=10` in systemd unit |

---

## Layer 4: Docker Compose Stack

**Source:** `~/ai-hub/deploy/docker-compose.yml` (tracked in repo, copied to `/opt/ai-hub/` on deploy)

Both custom services run as containers in the same compose stack. They communicate with Ollama on the host via `host.docker.internal`.

```yaml
services:
  ai-hub:
    build:
      context: ../hub        # path relative to repo root at build time
      dockerfile: Dockerfile
    image: ai-hub:latest
    restart: unless-stopped
    env_file:
      - /etc/ai-hub/hub.env
    environment:
      - CONFIG_PATH=/app/config.toml
      - STATE_DIR=/var/lib/ai-hub
    volumes:
      - /opt/ai-hub/config.toml:/app/config.toml:ro
      - hub-state:/var/lib/ai-hub
      - /var/run/docker.sock:/var/run/docker.sock  # coding sandbox (DooD)
    extra_hosts:
      - "host.docker.internal:host-gateway"

  open-webui:
    image: ghcr.io/open-webui/open-webui:main
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:8080"   # localhost only
    environment:
      - OLLAMA_BASE_URL=http://host.docker.internal:11434
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - open-webui:/app/backend/data

volumes:
  hub-state:
  open-webui:
```

**Docker socket note:** Mounting `/var/run/docker.sock` lets the hub spawn sibling containers for the coding sandbox (Docker-out-of-Docker). The effective privilege level is unchanged from the original design — the `openclaw` user was already in the `docker` group. No privileged mode is needed.

---

## Layer 5: Discord Server Structure

```
AI Hub (Discord Server)
├── #general        → Chat Agent (default)
├── #coding         → Coding Agent
├── #email          → Email triage announcements
├── #alerts         → Action items requiring your response
├── #daily-summary  → Automated daily summaries
└── #admin          → Bot status, errors, system notifications
```

**Bot setup:**
1. Create application at discord.com/developers
2. Enable privileged intents: Message Content (required)
3. Generate bot token → add to `/etc/ai-hub/hub.env`
4. Invite with scopes `bot`, permissions: Send Messages, Read Message History, Embed Links

---

## Layer 6: Network & Remote Access

### Principle: Zero Open Ports

The home router exposes nothing. All remote access works through outbound-only connections.

### Tailscale — Private Network (Primary Access)

All services reachable from trusted devices. SSH, Ollama API, and Open WebUI all accessible.

```bash
sudo pacman -S tailscale
sudo systemctl enable --now tailscaled
sudo tailscale up
# Enable MagicDNS in Tailscale admin console
```

### Cloudflare Tunnel — Custom Domain (Dashboard Access)

Exposes only Open WebUI on a custom domain, protected by Cloudflare Access.

```bash
yay -S cloudflared
cloudflared tunnel login
cloudflared tunnel create ai-hub
```

`~/.cloudflared/config.yml`:
```yaml
tunnel: <tunnel-id>
credentials-file: ~/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: hub.yourdomain.com
    service: http://localhost:3000   # Open WebUI
  - service: http_status:404
```

```bash
cloudflared tunnel route dns ai-hub hub.yourdomain.com
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

**Cloudflare Access:** Create Access Application for `hub.yourdomain.com`, policy: allow your email, auth: One-time PIN.

### Network Access Matrix

| Service | Tailscale | Cloudflare Tunnel | localhost | LAN/Internet |
|---|---|---|---|---|
| Open WebUI (dashboard) | Yes | Yes (+ Cloudflare Access) | Yes | No |
| Ollama API | Yes | No | Yes | No |
| SSH | Yes | No | No | No |
| Discord bot | N/A — outbound only | N/A | N/A | Outbound only |
| IMAP (email) | N/A — outbound only | N/A | N/A | Outbound only |

---

## Layer 7: Security Hardening

### Firewall

```bash
sudo pacman -S ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw enable
# No ports opened — Tailscale and cloudflared work outbound
```

### SSH (Tailscale only)

```
# /etc/ssh/sshd_config
ListenAddress 100.64.0.0/10    # Tailscale CGNAT range only
PermitRootLogin no
PasswordAuthentication no
MaxAuthTries 3
```

### Hub Service Security

- Runs inside a Docker container — process isolation by default
- Docker socket is mounted for coding sandbox (DooD); this is the same privilege level as being in the `docker` group
- `env_file` injects secrets at container start; they are never baked into the image
- `config.toml` is mounted read-only into the container

### Secrets Summary

| Secret | Location | Mode |
|---|---|---|
| Discord bot token | `/etc/ai-hub/hub.env` | 600, root |
| IMAP passwords | `/etc/ai-hub/hub.env` | 600, root |
| Cloudflare tunnel credentials | `~/.cloudflared/<id>.json` | 600 |
| IMAP UID state | Docker volume `hub-state` | container-managed |

---

## Implementation Plan (Hub Service)

The hub service is built incrementally, test-first for units with testable logic.

### Task 1: Project Scaffolding

**Files:** `hub/package.json`, `hub/tsconfig.json`, `hub/src/index.ts`, `hub/src/types.ts` (all in repo root)

```bash
mkdir -p hub/src hub/tests
cd hub
npm init -y
npm install discord.js@14 node-cron imapflow openai better-sqlite3 smol-toml
npm install -D typescript @types/node @types/better-sqlite3 @types/node-cron vitest tsx
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

`package.json` scripts:
```json
{
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

`src/types.ts`:
```typescript
export interface DiscordConfig {
  token_env: string;
  allowed_user_ids: string[];
  guild_id: string;
}

export interface ModelsConfig {
  default: string;
  coding: string;
  complex: string;
  ollama_base_url: string;
}

export interface ScheduleConfig {
  timezone: string;
  email_triage_cron: string;
  daily_summary_cron: string;
}

export interface EmailAccount {
  name: string;
  host: string;
  port: number;
  username: string;
  password_env: string;
  ssl: boolean;
  folders: string[];
}

export interface EmailConfig {
  accounts: EmailAccount[];
}

export interface Config {
  discord: DiscordConfig;
  models: ModelsConfig;
  schedule: ScheduleConfig;
  email: EmailConfig;
}
```

Minimal `src/index.ts` (expanded in Task 10):
```typescript
import { loadConfig } from './config.js';

async function main() {
  const config = loadConfig();
  console.log('AI Hub starting...');
}

main().catch((err) => { console.error('Fatal error:', err); process.exit(1); });
```

Also create `hub/Dockerfile` (multi-stage — TypeScript compiles inside Docker, runtime image has no build tools):

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
CMD ["node", "dist/index.js"]
```

Verify: `npm run build` → `dist/` created, no errors. (Local build useful for tests; the Dockerfile is the production build path.)

---

### Task 2: Config Loading

**Files:** `src/config.ts`, `tests/config.test.ts`, `deploy/config.toml.example`

`src/config.ts`:
```typescript
import fs from 'node:fs';
import { parse } from 'smol-toml';
import type { Config } from './types.js';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

export function loadConfig(): Config {
  const configPath = process.env.CONFIG_PATH ?? '/opt/ai-hub/config.toml';
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = parse(raw) as Config;
  requireEnv(parsed.discord.token_env);
  for (const account of parsed.email.accounts) {
    requireEnv(account.password_env);
  }
  return parsed;
}

export function getDiscordToken(config: Config): string {
  return requireEnv(config.discord.token_env);
}

export function getEmailPassword(account: { password_env: string }): string {
  return requireEnv(account.password_env);
}
```

Tests cover: valid config load, missing env var throws with var name, missing file throws.

Verify: `npm test` → 3 tests pass.

---

### Task 3: Ollama Client

**File:** `src/ollama.ts`

```typescript
import OpenAI from 'openai';
import type { Config } from './types.js';

export function createOllamaClient(config: Config): OpenAI {
  return new OpenAI({
    baseURL: config.models.ollama_base_url,
    apiKey: 'ollama',
  });
}

export async function chat(
  client: OpenAI,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });
  return response.choices[0]?.message?.content ?? '(no response)';
}
```

No unit tests — thin wrapper. Verify: `npm run build` → no errors.

---

### Task 4: Discord Routing Logic

**Files:** `src/discord/router.ts`, `tests/router.test.ts`

`src/discord/router.ts`:
```typescript
import type { Config } from '../types.js';

export interface Route {
  model: string;
  content: string;
  sandbox: boolean;
}

export function isAllowed(userId: string, config: Config): boolean {
  return config.discord.allowed_user_ids.includes(userId);
}

export function stripMention(content: string): string {
  return content.replace(/^<@!?\d+>\s*/, '').trim();
}

export function resolveRoute(channelName: string, content: string, config: Config): Route {
  if (content.startsWith('/think ')) {
    return {
      model: config.models.complex,
      content: content.slice('/think '.length).trim(),
      sandbox: false,
    };
  }
  if (channelName === 'coding') {
    return { model: config.models.coding, content, sandbox: true };
  }
  return { model: config.models.default, content, sandbox: false };
}
```

Tests cover: allowlist allow/block, channel routing, `/think` prefix model + content stripping, sandbox flag.

Verify: `npm test` → 8 tests pass.

---

### Task 5: Discord Bot

**Files:** `src/discord/bot.ts`, update `src/index.ts`

`src/discord/bot.ts` — creates a `discord.js` Client with `MessageContent` privileged intent, handles `messageCreate` events: checks allowlist, checks DM/mention, strips mention, calls `resolveRoute`, calls `chat()`, splits responses >2000 chars, replies with `⚠️ Model unavailable` on Ollama error.

No unit tests (live gateway required). Manual smoke test:
```bash
export DISCORD_TOKEN=your_bot_token_here
export CONFIG_PATH=/opt/ai-hub/config.toml
npm run dev
```

Expected: `Discord bot ready: YourBot#1234` in console. `@mention` in `#general` → Ollama response.

---

### Task 6: IMAP State Tracking

**Files:** `src/email/state.ts`, `tests/state.test.ts`

`src/email/state.ts` — SQLite-backed store for per-account last-seen IMAP UID. Interface: `getLastUid(account)`, `setLastUid(account, uid)`, `close()`.

Tests cover: default 0 for unseen account, store/retrieve, per-account isolation, update on subsequent calls.

Verify: `npm test` → 4 tests pass.

---

### Task 7: IMAP Email Fetcher

**File:** `src/email/imap.ts`

Fetches emails with UID > `sinceUid` using `imapflow`. Returns `{ emails: FetchedEmail[], maxUid: number }`. Extracts subject, from, date, and a 500-char snippet of the plain text body.

No unit tests (live IMAP required). Exercised through Task 9 manual trigger.

---

### Task 8: Email Triage Prompt Builder

**Files:** `src/email/triage.ts` (prompt builder), `tests/triage.test.ts`

`buildTriagePrompt(emails)` builds a structured prompt asking the model to categorize emails and identify action items, requesting JSON output with summary, per-email category/priority/action, and action_items array.

Tests cover: subjects in prompt, sender info in prompt, JSON keyword present, non-empty output for empty list.

Verify: `npm test` → 4 tests pass.

---

### Task 9: Email Triage Runner + Daily Summary

**Files:** `src/email/triage.ts` (add `runEmailTriage`), `src/cron/daily-summary.ts`

`runEmailTriage` — for each account: fetches unseen emails, calls Ollama with triage prompt, updates state store, posts summary to `#email`, posts action items to `#alerts`. Per-account errors post to `#admin` and don't block other accounts.

`runDailySummary` — calls Ollama with a brief prompt to write a friendly daily summary, posts to `#daily-summary`. Errors post to `#admin`.

Verify: `npm test` → all 19 tests pass.

---

### Task 10: Wire Up Cron Scheduler

**File:** `src/index.ts` (final version)

```typescript
import cron from 'node-cron';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from './config.js';
import { createOllamaClient } from './ollama.js';
import { createDiscordBot, startDiscordBot } from './discord/bot.js';
import { createStateStore } from './email/state.js';
import { runEmailTriage } from './email/triage.js';
import { runDailySummary } from './cron/daily-summary.js';

async function main() {
  const config = loadConfig();
  const ollamaClient = createOllamaClient(config);
  const stateDir = process.env.STATE_DIR ?? path.join(os.homedir(), '.local/share/ai-hub');
  const stateStore = createStateStore(path.join(stateDir, 'state.db'));
  const discordClient = createDiscordBot(config, ollamaClient);
  await startDiscordBot(discordClient, config);

  cron.schedule(config.schedule.email_triage_cron,
    () => runEmailTriage(config, ollamaClient, discordClient, stateStore).catch(console.error),
    { timezone: config.schedule.timezone });

  cron.schedule(config.schedule.daily_summary_cron,
    () => runDailySummary(config, ollamaClient, discordClient).catch(console.error),
    { timezone: config.schedule.timezone });

  console.log('AI Hub running. Cron jobs scheduled.');

  process.on('SIGTERM', () => {
    stateStore.close();
    discordClient.destroy();
    process.exit(0);
  });
}

main().catch((err) => { console.error('Fatal error:', err); process.exit(1); });
```

Verify: `npm run build && npm test` → build clean, 19 tests pass.

---

### Task 11: Deploy Script + Systemd Service

**Files in repo:** `deploy/deploy.sh`, `deploy/install-systemd.sh`, `deploy/docker-compose.yml`, `deploy/config.toml.example`, `systemd/ai-hub.service`

**`deploy/deploy.sh`** — builds the Docker image and syncs compose file to `/opt/ai-hub/`:
```bash
#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Build the hub Docker image
docker build -t ai-hub:latest "$REPO_ROOT/hub"

# Sync compose file and config example to runtime location
sudo mkdir -p /opt/ai-hub
sudo cp "$REPO_ROOT/deploy/docker-compose.yml" /opt/ai-hub/docker-compose.yml
sudo cp "$REPO_ROOT/deploy/config.toml.example" /opt/ai-hub/config.toml.example

echo "Deploy complete. Restart with: sudo systemctl restart ai-hub"
echo "First time? Copy config: sudo cp /opt/ai-hub/config.toml.example /opt/ai-hub/config.toml"
```

**`deploy/install-systemd.sh`** — installs the systemd unit (run once):
```bash
#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

sudo cp "$REPO_ROOT/systemd/ai-hub.service" /etc/systemd/system/ai-hub.service
sudo systemctl daemon-reload
echo "Unit installed. Enable with: sudo systemctl enable --now ai-hub"
```

First-time setup:
```bash
# Secrets file (fill in real values)
sudo mkdir -p /etc/ai-hub
sudo touch /etc/ai-hub/hub.env
sudo chmod 600 /etc/ai-hub/hub.env

# Deploy image + compose file
bash deploy/deploy.sh

# Edit config with real values (IDs, not secrets)
sudo cp /opt/ai-hub/config.toml.example /opt/ai-hub/config.toml
sudo $EDITOR /opt/ai-hub/config.toml

# Install and start
bash deploy/install-systemd.sh
sudo systemctl enable --now ai-hub
```

Verify: `docker compose -f /opt/ai-hub/docker-compose.yml logs -f ai-hub` → `AI Hub running. Cron jobs scheduled.`

---

### Task 12: Verify Full Stack

Open WebUI is now part of the same compose file as the hub — no separate task needed. After `deploy.sh` and systemd enable:

```bash
# Both services start together
sudo systemctl status ai-hub
docker compose -f /opt/ai-hub/docker-compose.yml ps

# Verify Open WebUI
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000  # expect 200

# Verify hub logs
docker compose -f /opt/ai-hub/docker-compose.yml logs ai-hub
```

Update Cloudflare Tunnel target to `:3000` (see Layer 6 above).

---

## Test Suite Summary

Run all tests: `cd /opt/ai-hub/hub && npm test`

| Test file | Tests | What it covers |
|---|---|---|
| `tests/config.test.ts` | 3 | Config parsing, env var validation |
| `tests/router.test.ts` | 8 | Channel routing, allowlist, mention stripping |
| `tests/state.test.ts` | 4 | IMAP UID persistence, per-account isolation |
| `tests/triage.test.ts` | 4 | Email triage prompt building |
| **Total** | **19** | |

---

## Open Questions

| Question | Needed By | Notes |
|----------|-----------|-------|
| Custom domain for Cloudflare Tunnel | Phase 4 | ~$10-15/yr if not already owned |
| Cloud model fallback: add Anthropic/OpenAI API key? | Phase 6 | Would require adding provider to hub's Ollama client |
| Additional IMAP accounts beyond Gmail? | Phase 3 | Design already supports multi-account via TOML array |

---

## Cost

| Item | Cost |
|------|------|
| Hardware | Already owned |
| Ollama | Free, open source |
| Node.js hub service | Free, open source |
| Open WebUI | Free, open source |
| Tailscale | Free tier (100 devices, 3 users) |
| Cloudflare | Free tier (tunnel + Access for up to 50 users) |
| Domain | ~$10-15/year (if not already owned) |
| Discord | Free |
| **Total** | **~$0-15/year** |
