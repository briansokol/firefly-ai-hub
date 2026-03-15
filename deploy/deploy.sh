#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OPT_DIR="/opt/ai-hub"

echo "==> Building ai-hub Docker image..."
docker build -t ai-hub:latest "$REPO_ROOT/hub"

echo "==> Syncing docker-compose.yml to $OPT_DIR..."
if [[ ! -d "$OPT_DIR" ]]; then
  echo "Error: $OPT_DIR does not exist. Run install-systemd.sh first." >&2
  exit 1
fi
sudo cp "$REPO_ROOT/deploy/docker-compose.yml" "$OPT_DIR/docker-compose.yml"
sudo cp "$REPO_ROOT/deploy/config.toml.example" "$OPT_DIR/config.toml.example"

echo "==> Checking if ai-hub service is running..."
if systemctl is-active --quiet ai-hub; then
  echo "==> Restarting ai-hub service..."
  sudo systemctl restart ai-hub
  echo "==> Restarted."
else
  echo "==> ai-hub service is not running (start it with: sudo systemctl start ai-hub)"
fi

echo ""
echo "Deploy complete."
