# AI Hub — Implementation Task List

Based on: `2026-02-28-ai-hub-architecture.md`
Last updated: 2026-02-28

---

## Phase 1: Foundation ✓

### 1. NVIDIA Driver Installation ✓
- [x] Install drivers: `sudo pacman -S nvidia nvidia-utils`
- [x] Install monitoring tool: `yay -S nvtop`
- [x] Reboot
- [x] Verify: `nvidia-smi` shows RTX 3090 with 24 GB VRAM
- [x] Verify: `nvtop` launches and shows GPU activity

### 2. Ollama Setup ✓
- [x] Install from AUR (CUDA variant): `yay -S ollama-cuda`
- [x] Enable and start service: `sudo systemctl enable --now ollama`
- [x] Configure service drop-in via `sudo systemctl edit ollama`:
  - `OLLAMA_HOST=127.0.0.1:11434`
  - `OLLAMA_MAX_VRAM=22`
  - `OLLAMA_KEEP_ALIVE=10m`
- [x] Pull Tier 1 model: `ollama pull qwen3:30b-a3b`
- [x] Pull Tier 2 model: `ollama pull qwen2.5-coder:32b`
- [x] Pull Tier 3 model: `ollama pull glm-4.7-flash`
- [x] Verify GPU inference: `ollama run qwen3:30b-a3b "Hello"`
- [x] Verify model is using GPU (check `nvidia-smi` during inference)

### 3. Docker ✓
- [x] Install: `sudo pacman -S docker`
- [x] Enable and start: `sudo systemctl enable --now docker`
- [x] Create service user: `sudo useradd -r -m -s /bin/nologin openclaw`
- [x] Add user to docker group: `sudo usermod -aG docker openclaw`
- [x] Verify: `docker run hello-world`

### 4. Tailscale ✓
- [x] Install: `sudo pacman -S tailscale`
- [x] Enable and start: `sudo systemctl enable --now tailscaled`
- [x] Authenticate: `sudo tailscale up`
- [x] Approve device in Tailscale admin console
- [x] Enable MagicDNS in Tailscale admin console
- [x] Verify remote SSH access via Tailscale IP/hostname

---

## Phase 2: Hub Service + Discord

### 5. Hub Service Build (source in `hub/` — see architecture doc Tasks 1–10)
- [x] Scaffold: `mkdir -p hub/src hub/tests && cd hub && npm init -y`
- [x] Install dependencies (discord.js, node-cron, imapflow, openai, better-sqlite3, smol-toml + dev deps)
- [x] Write `hub/src/types.ts`, `hub/tsconfig.json`, minimal `hub/src/index.ts`
- [x] Write `hub/Dockerfile` (multi-stage: build → runtime)
- [x] Verify: `npm run build` → `hub/dist/` created; `docker build -t ai-hub:latest hub/` succeeds
- [x] Write `hub/src/config.ts` — `npm test` → 5 tests pass
- [x] Write `hub/src/ollama.ts` — `npm run build` → no errors
- [x] Write `hub/src/discord/router.ts` — `npm test` → 8 tests pass
- [x] Write `hub/src/discord/bot.ts`, update `hub/src/index.ts`
- [x] Write `hub/src/email/state.ts` — `npm test` → 17 tests pass
- [x] Write `hub/src/email/imap.ts`
- [x] Write `hub/src/email/triage.ts` (prompt builder) — `npm test` → 28 tests pass
- [x] Write `deploy/docker-compose.yml` (4 services: ai-hub, open-webui, temporal, postgresql)
- [x] Write `deploy/config.toml.example`
- [x] Write `deploy/deploy.sh` (builds Docker image, syncs compose file)
- [x] Write `deploy/install-systemd.sh`, `systemd/ai-hub.service`

### 5b. Temporal Integration (see `plans/2026-03-02-temporal-integration-design.md`) ✓

- [x] Install Temporal SDK: `npm install @temporalio/client @temporalio/worker @temporalio/workflow @temporalio/activity`
- [x] Remove `node-cron` dependency: `npm uninstall node-cron @types/node-cron`
- [x] Write `hub/src/temporal/activities.ts` — wrappers around `imap.ts`, `triage.ts`, `ollama.ts`, `state.ts`
- [x] Write `hub/src/temporal/workflows.ts` — `chatWorkflow`, `emailTriageWorkflow`, `dailySummaryWorkflow`
- [x] Write `hub/src/temporal/worker.ts` — Worker setup, task queue `ai-hub`
- [x] Write `hub/src/temporal/schedules.ts` — registers email-triage + daily-summary Schedules on startup
- [x] Update `hub/src/discord/bot.ts` — start `chatWorkflow` via Temporal Client instead of direct `chat()` call
- [x] Write final `hub/src/index.ts` — start Worker + register Schedules, no node-cron
- [x] `npm run build && npm test` → no errors

### 6. Deploy & Start Full Stack
- [x] Create `/etc/ai-hub/hub.env` (mode 600), fill in secrets
- [x] Run deploy: `bash deploy/deploy.sh`
- [x] Copy and edit config: `sudo cp /opt/ai-hub/config.toml.example /opt/ai-hub/config.toml`
- [x] Run install: `bash deploy/install-systemd.sh`
- [x] Enable and start: `sudo systemctl enable --now ai-hub`
- [ ] Verify hub: `docker compose -f /opt/ai-hub/docker-compose.yml logs ai-hub` → "AI Hub running"
- [ ] Verify Open WebUI: `curl http://localhost:3000` → HTTP 200
  > BLOCKED: Docker can't set up DNAT rule for open-webui port 3000.
  > Error: "Extension DNAT revision 0 not supported, missing kernel module?"
  > Cause: legacy iptables installed; switched to iptables-nft but issue persists.
  > Next step: reboot (in progress) — nftables modules should load cleanly on fresh boot.
  > If still broken after reboot: check `lsmod | grep nf_nat`, check `iptables --version`.

### 7. Discord Bot Setup
- [x] Create Discord application at discord.com/developers
- [x] Enable Message Content Intent (Bot → Privileged Gateway Intents)
- [x] Generate bot token → add to `/etc/ai-hub/hub.env`
- [x] Create Discord server with channels: `#general`, `#coding`, `#email`, `#alerts`, `#daily-summary`, `#admin`
- [x] Invite bot with scopes `bot`, permissions: Send Messages, Read Message History, Embed Links
- [x] Add your Discord user ID and guild ID to `/opt/ai-hub/config.toml`
- [ ] Restart service: `sudo systemctl restart ai-hub` (blocked on Task 6)

### 8. End-to-End Validation
- [ ] Send @mention in `#general` → verify Ollama response (qwen3:30b-a3b)
- [ ] Send @mention in `#coding` → verify coding model response (qwen2.5-coder:32b)
- [ ] Send `/think <question>` → verify complex model response (glm-4.7-flash)
- [ ] Verify non-allowlisted user is silently ignored

---

## Phase 3: Agents & Automation

### 9. Email Integration
- [ ] Add IMAP credentials to `/etc/ai-hub/hub.env`
- [ ] Configure `[[email.accounts]]` sections in `/opt/ai-hub/config.toml`
- [ ] Trigger email triage manually to test (temporarily call `runEmailTriage` on startup)
- [ ] Verify triage results post to `#email` and action items to `#alerts`
- [ ] Restore normal cron-only behavior, restart service

### 10. Verify Full Stack
- [ ] Open WebUI is included in the compose stack — no separate deploy needed
- [ ] Confirm both containers running: `docker compose -f /opt/ai-hub/docker-compose.yml ps`
- [ ] Verify Open WebUI: `curl http://localhost:3000` returns HTTP 200

---

## Phase 4: Remote Access & Dashboard

### 11. Cloudflare Tunnel
- [ ] Install cloudflared: `yay -S cloudflared`
- [ ] Authenticate: `cloudflared tunnel login`
- [ ] Create tunnel: `cloudflared tunnel create ai-hub`
- [ ] Write `~/.cloudflared/config.yml` pointing to `localhost:3000` (Open WebUI)
- [ ] Route DNS: `cloudflared tunnel route dns ai-hub hub.yourdomain.com`
- [ ] Install and enable service: `sudo cloudflared service install && sudo systemctl enable --now cloudflared`

### 12. Cloudflare Access (Zero Trust)
- [ ] Create Access Application for `hub.yourdomain.com` in Cloudflare Zero Trust dashboard
- [ ] Set policy: allow your email address (and any trusted users)
- [ ] Set auth method: One-time PIN via email
- [ ] Test: access dashboard from external network (phone on cellular)

---

## Phase 5: Security Hardening

### 13. Firewall & OS Hardening
- [ ] Install and configure UFW:
  - `sudo pacman -S ufw`
  - `sudo ufw default deny incoming`
  - `sudo ufw default allow outgoing`
  - `sudo ufw enable`
- [ ] Harden SSH config (`/etc/ssh/sshd_config`):
  - `ListenAddress` restricted to Tailscale CGNAT range
  - `PermitRootLogin no`
  - `PasswordAuthentication no`
  - `MaxAuthTries 3`
- [ ] Verify no open ports on router (external port scan)

---

## Phase 6: Refinement (Ongoing)

### 14. Tuning & Evaluation
- [ ] Tune system prompts for each agent based on real usage
- [ ] Evaluate Open WebUI's dashboard vs. need for custom extension
- [ ] Re-evaluate model choices quarterly (local model landscape evolves fast)
- [ ] Consider cloud model fallback (Anthropic/OpenAI) if local quality gaps emerge
- [ ] Explore additional automations: calendar, RSS feeds, notifications

---

## Open Questions (Resolve Before Relevant Phase)

| Question | Needed By | Notes |
|----------|-----------|-------|
| Custom domain for Cloudflare Tunnel | Phase 4, Task 11 | ~$10-15/yr if not already owned |
| Cloud model fallback: add Anthropic/OpenAI API key? | Phase 6 | Hub service would need updated Ollama client |
| Additional IMAP accounts beyond Gmail? | Phase 3, Task 9 | Config already supports multi-account |
