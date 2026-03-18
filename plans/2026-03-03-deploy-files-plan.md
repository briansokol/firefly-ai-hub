# Deploy Files Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Write the four remaining deploy files so the AI Hub stack can be installed and redeployed from the repo.

**Architecture:** Static config template + two shell scripts + one systemd unit. `install-systemd.sh` is run once to set up `/opt/ai-hub/` and register the service. `deploy.sh` is run on every redeploy to rebuild the image and sync the compose file. The systemd unit manages the full Docker Compose stack as a single service.

**Tech Stack:** bash, systemd, Docker Compose, TOML

---

### Task 1: Write `deploy/config.toml.example`

**Files:**
- Create: `deploy/config.toml.example`

**Step 1: Write the file**

```toml
[discord]
token_env = "DISCORD_TOKEN"
allowed_user_ids = ["YOUR_DISCORD_USER_ID"]
guild_id = "YOUR_GUILD_ID"

[channels]
general   = "CHANNEL_ID_GENERAL"
coding    = "CHANNEL_ID_CODING"
email     = "CHANNEL_ID_EMAIL"
alerts    = "CHANNEL_ID_ALERTS"
summary   = "CHANNEL_ID_DAILY_SUMMARY"
admin     = "CHANNEL_ID_ADMIN"

[models]
default  = "qwen3:30b-a3b"
coding   = "qwen2.5-coder:32b"
complex  = "glm-4.7-flash"
ollama_base_url = "http://host.docker.internal:11434/v1"

[schedule]
timezone           = "America/New_York"
email_triage_cron  = "0 7 * * *"
daily_summary_cron = "0 21 * * *"

[[email.accounts]]
name         = "gmail"
host         = "imap.gmail.com"
port         = 993
username     = "you@gmail.com"
password_env = "GMAIL_APP_PASSWORD"
ssl          = true
folders      = ["INBOX"]
```

**Step 2: Verify it parses**

Run:
```bash
cd hub && node -e "import('smol-toml').then(m => { require('fs'); console.log(JSON.stringify(m.parse(require('fs').readFileSync('../deploy/config.toml.example','utf8')), null, 2)) })"
```
Or simply inspect visually — all keys must be present and match the `Config` type in `hub/src/types.ts`.

**Step 3: Cross-check with `hub/src/types.ts`**

Open `hub/src/types.ts` and confirm every field in the example maps to a key in the `Config` type. Pay attention to `channels` — if the type doesn't include it yet, note it but don't add it now (out of scope).

**Step 4: Commit**

```bash
git add deploy/config.toml.example
git commit -m "feat(deploy): add config.toml.example template"
```

---

### Task 2: Write `systemd/ai-hub.service`

**Files:**
- Create: `systemd/ai-hub.service`

**Step 1: Create the systemd directory and write the file**

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

**Step 2: Verify syntax**

Run:
```bash
systemd-analyze verify systemd/ai-hub.service
```
Expected: no output (no errors). If `systemd-analyze` isn't available, skip — it will be caught at install time.

**Step 3: Commit**

```bash
git add systemd/ai-hub.service
git commit -m "feat(deploy): add ai-hub systemd unit"
```

---

### Task 3: Write `deploy/install-systemd.sh`

This script is run once on first install. It needs `sudo` (or to be run as root).

**Files:**
- Create: `deploy/install-systemd.sh`

**Step 1: Write the script**

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_SRC="$REPO_ROOT/systemd/ai-hub.service"
SERVICE_DEST="/etc/systemd/system/ai-hub.service"
OPT_DIR="/opt/ai-hub"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

echo "Creating $OPT_DIR..."
mkdir -p "$OPT_DIR"
chmod 755 "$OPT_DIR"

echo "Installing systemd unit..."
cp "$SERVICE_SRC" "$SERVICE_DEST"
chmod 644 "$SERVICE_DEST"

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
```

**Step 2: Make it executable**

```bash
chmod +x deploy/install-systemd.sh
```

**Step 3: Dry-run check (no sudo needed)**

Inspect the script manually:
- Does it check for root? Yes.
- Does it reference `$REPO_ROOT` correctly (relative to script location, not cwd)? Yes.
- Does it create `/opt/ai-hub/` with correct permissions? Yes.
- Does it run `systemctl daemon-reload`? Yes.
- Does it print clear next-step instructions? Yes.

**Step 4: Commit**

```bash
git add deploy/install-systemd.sh
git commit -m "feat(deploy): add install-systemd.sh one-time setup script"
```

---

### Task 4: Write `deploy/deploy.sh`

This is the redeploy script run from the repo root on every update.

**Files:**
- Create: `deploy/deploy.sh`

**Step 1: Write the script**

```bash
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
cp "$REPO_ROOT/deploy/docker-compose.yml" "$OPT_DIR/docker-compose.yml"

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
```

**Step 2: Make it executable**

```bash
chmod +x deploy/deploy.sh
```

**Step 3: Inspect the script**

Verify:
- `$REPO_ROOT` derived from script location (not cwd). Correct.
- Fails fast if `/opt/ai-hub` doesn't exist (tells user to run install first). Correct.
- `docker build` uses `hub/` directory. Correct — matches the `build: context: ../hub` in docker-compose.yml.
- `systemctl is-active` check before restart avoids errors on first run. Correct.
- `sudo systemctl restart` — the script itself doesn't require root (docker group handles the build), but the restart does. Correct to scope sudo narrowly.

**Step 4: Commit**

```bash
git add deploy/deploy.sh
git commit -m "feat(deploy): add deploy.sh build and sync script"
```

---

### Task 5: Mark tasks done in `plans/tasks.md`

**Files:**
- Modify: `plans/tasks.md`

**Step 1: Check off the three completed subtasks**

In the `### 5. Hub Service Build` section, mark these as done:
```
- [x] Write `deploy/config.toml.example`
- [x] Write `deploy/deploy.sh`
- [x] Write `deploy/install-systemd.sh`, `systemd/ai-hub.service`
```

**Step 2: Commit**

```bash
git add plans/tasks.md
git commit -m "chore: mark deploy files tasks complete"
```
