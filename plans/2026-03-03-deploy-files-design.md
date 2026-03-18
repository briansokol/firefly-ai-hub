# Deploy Files Design

**Date:** 2026-03-03
**Status:** Approved

## Scope

Four files to complete the deploy infrastructure for the AI Hub:

- `deploy/config.toml.example`
- `deploy/deploy.sh`
- `deploy/install-systemd.sh`
- `systemd/ai-hub.service`

## Files

### `deploy/config.toml.example`

Static TOML template matching the structure in the architecture doc. Contains all config keys with placeholder values. Safe to commit — no secrets.

### `systemd/ai-hub.service`

Systemd unit managing the full compose stack. Runs as root. Spec from architecture doc:
- `Type=simple`
- `WorkingDirectory=/opt/ai-hub`
- `ExecStart=/usr/bin/docker compose up`
- `ExecStop=/usr/bin/docker compose down`
- `After=docker.service ollama.service`, `Requires=docker.service`
- `Restart=on-failure`, `RestartSec=10`

### `deploy/install-systemd.sh`

One-time setup script, requires `sudo`. Steps:
1. Create `/opt/ai-hub/` (owned by root, mode 755)
2. Copy `systemd/ai-hub.service` → `/etc/systemd/system/ai-hub.service`
3. Run `systemctl daemon-reload`
4. Print instructions to enable and start the service

Does not enable or start the service automatically — user does that after filling in config/secrets.

### `deploy/deploy.sh`

Redeploy script, run from repo root on the server. Steps:
1. Build `ai-hub:latest` from `hub/`
2. Copy `deploy/docker-compose.yml` → `/opt/ai-hub/docker-compose.yml`
3. If `ai-hub` systemd service is active, restart it to pick up the new image

## Deployment Flow

```
First time:
  bash deploy/install-systemd.sh
  sudo cp /opt/ai-hub/config.toml.example /opt/ai-hub/config.toml
  # edit config.toml + /etc/ai-hub/hub.env
  sudo systemctl enable --now ai-hub

Subsequent deploys:
  bash deploy/deploy.sh
```
