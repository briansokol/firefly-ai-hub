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
# Environment=OLLAMA_HOST=127.0.0.1:11434
# Environment=OLLAMA_MAX_VRAM=22
# Environment=OLLAMA_KEEP_ALIVE=10m

ollama pull qwen3:30b-a3b
ollama pull qwen2.5-coder:32b
ollama pull glm-4.7-flash
```

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

## Stack

| Service | Port | Notes |
|---------|------|-------|
| ai-hub | — | Discord bot + email triage (no exposed port) |
| open-webui | 127.0.0.1:3000 | Local LLM chat UI |
| temporal | 127.0.0.1:7233 | Workflow engine |
| temporal UI | 127.0.0.1:8080 | Temporal web dashboard |
| postgresql | — | Internal only (Temporal backend) |
| ollama | 127.0.0.1:11434 | GPU inference (host, not Docker) |
