# firefly AI Hub

This repo contains the code and plans for the AI Hub running on `firefly` (Arch Linux, RTX 3090).

---

## System Setup Log

All commands that changed system state, in order of execution.

### NVIDIA Drivers

```bash
sudo pacman -S nvidia nvidia-utils
yay -S nvtop
# reboot
```

### Ollama (CUDA)

```bash
yay -S ollama-cuda
sudo systemctl enable --now ollama

# Drop-in config: sudo systemctl edit ollama
# Added:
# [Service]
# Environment=OLLAMA_HOST=0.0.0.0:11434
# Environment=OLLAMA_MAX_VRAM=22
# Environment=OLLAMA_KEEP_ALIVE=10m

ollama pull qwen3:30b-a3b
ollama pull qwen2.5-coder:32b
ollama pull glm-4.7-flash
```

> **Note:** `OLLAMA_HOST=0.0.0.0` is required so Docker containers can reach Ollama via
> `host.docker.internal`. Using `127.0.0.1` (loopback only) causes "Model unavailable" errors
> from within the ai-hub container even though `extra_hosts: host-gateway` is set — the gateway
> IP is not loopback.

### Docker

```bash
sudo pacman -S docker
sudo systemctl enable --now docker
sudo useradd -r -m -s /bin/nologin openclaw
sudo usermod -aG docker openclaw
```

### Docker Compose

```bash
sudo pacman -S docker-compose
```

### Tailscale

```bash
sudo pacman -S tailscale
sudo systemctl enable --now tailscaled
sudo tailscale up
# Approved device in Tailscale admin console
# Enabled MagicDNS in Tailscale admin console
```

### iptables (Docker networking fix)

On Arch with kernel 6.19+, Docker's DNAT rules fail without this. The kernel modules are
built-in so modprobe is not needed, but the Docker chain needed to be flushed after stale
rules accumulated:

```bash
# Persist iptables module load on boot (no-op on this kernel but kept for clarity)
echo -e "ip_tables\niptable_nat\niptable_filter" | sudo tee /etc/modules-load.d/iptables.conf

# Flush stale Docker iptables rules (run once to fix DROP rules in DOCKER chain)
sudo systemctl stop ai-hub
sudo systemctl stop docker
sudo iptables -F DOCKER
sudo iptables -t nat -F DOCKER
sudo systemctl start docker
```

---

## AI Hub Service

### First-time install

```bash
# 1. Create secrets file
sudo mkdir -p /etc/ai-hub
sudo touch /etc/ai-hub/hub.env
sudo chmod 600 /etc/ai-hub/hub.env
# Add: DISCORD_TOKEN=... and GMAIL_APP_PASSWORD=... (if using email)

# 2. Install systemd unit and create /opt/ai-hub/
sudo bash deploy/install-systemd.sh

# 3. Build Docker image and sync compose file
bash deploy/deploy.sh

# 4. Copy and edit config
sudo cp /opt/ai-hub/config.toml.example /opt/ai-hub/config.toml
sudo $EDITOR /opt/ai-hub/config.toml

# 5. Enable and start
sudo systemctl enable --now ai-hub
```

### Redeploying after code changes

```bash
bash deploy/deploy.sh
```

### Files installed to the system

| Path | Description |
|------|-------------|
| `/etc/systemd/system/ai-hub.service` | Systemd unit (manages Docker Compose stack) |
| `/etc/ai-hub/hub.env` | Secrets: bot token, app passwords (mode 600) |
| `/opt/ai-hub/docker-compose.yml` | Compose stack (synced by deploy.sh) |
| `/opt/ai-hub/config.toml` | Runtime config: channels, models, schedule |
| `/etc/modules-load.d/iptables.conf` | iptables modules on boot |

---

## Shutdown and Restart

The whole stack is a single Docker Compose project managed by `ai-hub.service`. There is no
separate unit for Temporal, Postgres, or anything else: they are all containers in that one
compose project.

### Shutdown (keeps all data)

```bash
# 1. Stop the stack and clear the boot symlink.
#    systemd's ExecStop runs `docker compose down` in /opt/ai-hub, which stops and REMOVES the
#    containers and the network. Named volumes are untouched (no `-v` flag).
sudo systemctl disable --now ai-hub

# 2. Bring down the stray `deploy` project if it exists.
#    Running `docker compose -f deploy/docker-compose.yml ...` from the repo creates a SECOND
#    project named after the directory (`deploy`), with its own containers and volumes. Its
#    postgres carries `restart: unless-stopped` and would survive a reboot on its own.
docker compose --project-name deploy -f deploy/docker-compose.yml down

# 3. Verify
docker ps                     # no ai-hub-* or deploy-* containers
docker volume ls              # ai-hub_hub-state, ai-hub_temporal-db, ai-hub_qdrant-data,
                              # ai-hub_open-webui all still listed
systemctl is-enabled ai-hub   # disabled
```

> **Never add `-v` / `--volumes` to `docker compose down`.** That is the flag that deletes the
> data.

#### Why Temporal will not come back on its own

Temporal has no systemd unit. It is a container with `restart: unless-stopped`, which only means
"restart me if I die or the daemon restarts, unless I was explicitly stopped." Because
`docker compose down` *removes* the container rather than stopping it, the restart policy has
nothing left to act on. Disabling `ai-hub.service` is what keeps it from being recreated at boot.
Both steps together are the guarantee.

`docker.service` stays enabled, which is fine: with no containers left, it has nothing to bring up.

#### What is left running

| Thing | State after shutdown |
|-------|----------------------|
| `ollama.service` | Still running (host service, not Docker). Already `disabled` at boot. Use `sudo systemctl stop ollama` to reclaim the 3090's VRAM. |
| `docker.service` | Still enabled and running. Harmless with no containers. |
| `tailscaled` | Untouched. |

#### What goes dark

- Discord bot (no response to `!shorts` and friends)
- Sync API on `firefly:8788` (app clients cannot pull, push, or search memories)
- LiteLLM gateway on `firefly:4000` (per-user virtual keys stop resolving)
- Open WebUI on `:3000` and its public `cloudflared` tunnel
- Temporal UI on `:8080`
- Every scheduled workflow: email triage, hourly email categorization, daily summary, memory
  distillation (every 15 min), and the RGB work/night/off schedules

### Restart

```bash
# 1. Ollama is `disabled` at boot, so after a reboot it is NOT running and the hub answers
#    "Model unavailable" without it. Start it first.
sudo systemctl start ollama
curl -s localhost:11434/api/tags | head -c 200

# 2. Confirm config and secrets survived.
ls -l /opt/ai-hub/config.toml /opt/ai-hub/docker-compose.yml
sudo ls -l /etc/ai-hub/hub.env /etc/ai-hub/memory.env

# 3. Rebuild the image and re-sync the compose symlink. The repo has probably moved on since
#    shutdown, and /opt/ai-hub/docker-compose.yml is a symlink INTO the repo, so whatever
#    branch is checked out is what runs.
bash deploy/deploy.sh

# 4. Re-enable and start.
sudo systemctl enable --now ai-hub

# 5. Verify.
systemctl status ai-hub
docker compose -f /opt/ai-hub/docker-compose.yml ps   # 9 services; temporal + postgres healthy
docker logs -f ai-hub-ai-hub-1
```

`deploy.sh` only restarts the service if it is already active, so on a cold start step 4 is what
actually brings the stack up.

#### After restart

- Volumes reattach by name, so Temporal history, the sync/memory Postgres databases, Qdrant
  vectors, and Open WebUI state all come back as they were.
- `registerSchedules()` (`hub/src/temporal/schedules.ts`) re-registers the schedules on boot.
  They also live in `ai-hub_temporal-db`, so they were never lost.
- Schedules use `catchupWindow: '1 day'`, so Temporal fires runs missed during the outage if it
  was shorter than a day. Expect a burst of backfilled `memory-distill` and email runs;
  `ScheduleOverlapPolicy.SKIP` keeps them from running concurrently. Outages longer than a day
  drop the missed runs entirely.
- If Docker's DNAT rules misbehave after the outage, see the iptables fix in the System Setup Log
  above.

---

## Troubleshooting

### `ERR_DLOPEN_FAILED` — Temporal core-bridge native module fails to load

**Symptom:** `Error loading shared library ld-linux-x86-64.so.2: No such file or directory`

**Cause:** `@temporalio/core-bridge` ships a prebuilt native binary targeting glibc
(`x86_64-unknown-linux-gnu`). Alpine-based Docker images use musl libc, which is incompatible.

**Fix:** Use `node:22-slim` (Debian/glibc) instead of `node:22-alpine` in `hub/Dockerfile`.

---

### Bot responds "Model unavailable" — Ollama unreachable from container

**Symptom:** Discord bot replies with ⚠️ Model unavailable despite Ollama running on the host.

**Cause:** Ollama was bound to `127.0.0.1:11434` (loopback only). Docker containers reach the
host via the bridge gateway IP (via `host.docker.internal`), which is not loopback — so
connections are refused even with `extra_hosts: host-gateway` configured.

**Fix:** Set `OLLAMA_HOST=0.0.0.0:11434` in the Ollama systemd drop-in:

```bash
sudo systemctl edit ollama
# Set: Environment=OLLAMA_HOST=0.0.0.0:11434
sudo systemctl restart ollama
```

Verify from inside the container:

```bash
docker exec ai-hub-ai-hub-1 node -e \
  "fetch('http://host.docker.internal:11434/api/tags').then(r=>r.json()).then(d=>console.log(d.models?.map(m=>m.name))).catch(e=>console.error(e.message))"
```

---

## Stack

Nine containers in the `ai-hub` compose project, plus Ollama on the host. `100.100.205.20` is
firefly's tailnet IP, so those ports are reachable as `firefly:<port>` over Tailscale but are not
bound to `0.0.0.0`.

| Service | Published port | Notes |
|---------|----------------|-------|
| ai-hub | `100.100.205.20:8788` | Discord bot, email triage, Temporal worker, sync API. Tailnet only, by design. |
| ai-hub (web tools) | none | HTTP API on container port 8787, reachable only as `http://ai-hub:8787` inside the compose network. Consumed by the Open WebUI `hub_web_tools.py` Tool. |
| litellm | `100.100.205.20:4000` | LLM gateway, per-user virtual keys scoped by profile. Tailnet only. |
| open-webui | `0.0.0.0:3000` | Local LLM chat UI. Also reachable publicly through the cloudflared tunnel. |
| openai-edge-tts | none | TTS backend for Open WebUI, internal only (container port 5050). |
| cloudflared | none | Outbound tunnel that publishes Open WebUI. |
| temporal | `127.0.0.1:7233` | Workflow engine (gRPC). |
| temporal-ui | `0.0.0.0:8080` | Temporal web dashboard. Note this binds all interfaces, not loopback. |
| qdrant | `127.0.0.1:6333` | Vector store for distilled memories. |
| postgresql | none | Internal only. Backs the `temporal`, `firefly_sync`, and `litellm` databases. |
| ollama | `0.0.0.0:11434` | GPU inference on the host, not Docker. Binds all interfaces so containers can reach it via `host.docker.internal`. |

### Data volumes

These are what `docker compose down` preserves and `down -v` would destroy.

| Volume | Contents |
|--------|----------|
| `ai-hub_temporal-db` | Postgres data: Temporal history plus the `firefly_sync` and `litellm` databases |
| `ai-hub_qdrant-data` | Qdrant vectors for distilled memories |
| `ai-hub_open-webui` | Open WebUI users, chats, and installed Functions |
| `ai-hub_hub-state` | Hub state DB (`/var/lib/ai-hub`) |

`docker volume ls` also shows `deploy_hub-state`, `deploy_temporal-db`, a bare `hub-state`, and
some hash-named volumes. Those are leftovers from earlier runs of the stray `deploy` project and
from one-off containers. Nothing in the live stack mounts them.
