#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OPT_DIR="/opt/ai-hub"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

echo "Creating $OPT_DIR..."
mkdir -p "$OPT_DIR"
chmod 755 "$OPT_DIR"

echo "Creating /var/run/ai-hub..."
mkdir -p /var/run/ai-hub

echo "Installing systemd units..."
cp "$REPO_ROOT/systemd/ai-hub.service" /etc/systemd/system/ai-hub.service
cp "$REPO_ROOT/systemd/rgb-server.service" /etc/systemd/system/rgb-server.service
chmod 644 /etc/systemd/system/ai-hub.service /etc/systemd/system/rgb-server.service

systemctl daemon-reload

echo ""
echo "Done. Next steps:"
echo "  1. Run deploy.sh to build and copy the compose file:"
echo "       bash $REPO_ROOT/deploy/deploy.sh"
echo "  2. Copy and edit the config:"
echo "       sudo cp $OPT_DIR/config.toml.example /opt/ai-hub/config.toml"
echo "       sudo \$EDITOR /opt/ai-hub/config.toml"
echo "  3. Create /etc/ai-hub/hub.env (mode 600) with DISCORD_TOKEN etc."
echo "  4. Enable and start the service:"
echo "       sudo systemctl enable --now ai-hub"
