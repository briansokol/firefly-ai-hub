# Agent Instructions

This file provides guidance to agents working with this AI Hub repository.

## Purpose

This repository is for planning and building an AI Hub on this server. It serves as both a planning workspace and a codebase for any code that gets written.

## Repository Structure

- `plans/` — Planning documents for AI Hub components and features
- `hub/` — Main TypeScript application (Discord bot, Temporal workflows, AI integrations)
- `hub/src/shorts/` — YouTube Shorts auto-clip pipeline
- `hub/src/temporal/` — Temporal workflow definitions and activity implementations
- `hub/src/discord/` — Discord bot and command routing
- `rgb/` — RGB lighting server
- `deploy/` — Docker Compose and systemd deployment configs
- `systemd/` — Systemd service files

## Key Files

| File | Purpose |
|------|---------|
| `hub/src/shorts/workflow.ts` | Temporal workflow orchestration (main + edit) |
| `hub/src/shorts/candidates.ts` | Sliding-window LLM scoring, deduplication, diversity enforcement |
| `hub/src/shorts/hosted-scoring.ts` | Gemini/Claude confirmation with video/image understanding |
| `hub/src/shorts/clip-processing.ts` | FFmpeg clip extraction, 9:16 cropping, subtitle burn-in |
| `hub/src/shorts/transcription.ts` | Faster-whisper word-level transcription |
| `hub/src/shorts/audio-analysis.ts` | FFmpeg audio extraction and loudness peak detection |
| `hub/src/shorts/audio-classify.ts` | YAMNet audio event detection (Python script) |
| `hub/src/shorts/prosody.ts` | Parselmouth pitch/energy analysis (Python script) |
| `hub/src/shorts/audio-features.ts` | Per-second feature vector computation |
| `hub/src/shorts/titles.ts` | Ollama-based episode title suggestions |
| `hub/src/shorts/cleanup.ts` | Workspace intermediate file cleanup |
| `hub/src/shorts/types.ts` | All data types (VideoMeta, Candidate, ConfirmedCandidate, etc.) |
| `hub/src/temporal/activities.ts` | Activity implementations (resolveVideo, slugifyTitle, clip processing, Discord posting) |
| `hub/src/discord/router.ts` | Command parsers (parseShortsCommand, parseShortsEditCommand) |

## Discord Commands
- `!shorts <URL>` — Start full analysis pipeline for a video
- `!shorts-edit <workspace-name>` — Re-process clips from checkpoint (skips detection, re-renders clips)
  - Accepts just the folder name (e.g. `my-cool-video`), resolved against `workspace_dir`
  - Also accepts absolute paths for backwards compatibility

## YouTube Shorts Pipeline

The shorts system automatically finds viral-worthy moments in YouTube videos, extracts clips, and posts them to Discord.

### Pipeline Steps
1. **Download & workspace creation** — yt-dlp download, workspace named from slugified video title (everything before `|`)
2. **Audio extraction + transcription** (parallel) — FFmpeg → WAV, faster-whisper → word-level timestamps
3. **Audio analysis** (parallel) — loudness peaks (ebur128), YAMNet event classification (laughter/cheering), parselmouth prosody (pitch/energy)
4. **Candidate scoring** — sliding-window LLM scoring via Ollama, optional two-pass with screening model
5. **Hosted AI confirmation** (optional) — Gemini (video) or Claude (keyframe) re-scores, determines crop position
6. **Checkpoint save** — `checkpoint.json` for `!shorts-edit` resume
7. **Clip processing** (parallel) — boundary snapping to speech gaps, 9:16 crop, subtitle burn-in, libx264 CRF 18
8. **Discord notification** — posts clips (<25MB) or NAS paths, workspace name for re-editing
9. **Cleanup** — removes intermediates, keeps source video, final clips, and checkpoint

## Development Setup

### Requirements
- Node.js 22+
- Docker and Docker Compose
- Ollama (with CUDA support)
- Python 3.10+ with required packages

### Running Tests
```bash
cd hub
npm test
```

### Running Dev Server
```bash
cd hub
npm run dev
```

### Build Production
```bash
cd hub
npm run build
```

## Configuration

Configuration lives in `/opt/ai-hub/config.toml` with a `.example` file as reference.

External secrets must be configured in `/etc/ai-hub/hub.env` with permissions 600.

## Deployment

1. Create secrets file:
```bash
sudo mkdir -p /etc/ai-hub
sudo touch /etc/ai-hub/hub.env
sudo chmod 600 /etc/ai-hub/hub.env
```

2. Install systemd unit and create `/opt/ai-hub/`:
```bash
sudo bash deploy/install-systemd.sh
```

3. Build Docker image and sync compose file:
```bash
bash deploy/deploy.sh
```

4. Copy and edit config:
```bash
sudo cp /opt/ai-hub/config.toml.example /opt/ai-hub/config.toml
sudo $EDITOR /opt/ai-hub/config.toml
```

5. Enable and start:
```bash
sudo systemctl enable --now ai-hub
```

## Environment Variables

- `DISCORD_TOKEN` – Discord bot token
- `GMAIL_APP_PASSWORD` – Gmail IMAP app password
- `CONFIG_PATH` – Override config file location (default: `/opt/ai-hub/config.toml`)
- `STATE_DIR` – Override state database directory (default: `~/.local/share/firefly-ai-hub`)
- `TEMPORAL_ADDRESS` – Override Temporal client address (default: `localhost:7233`)

## Important Notes

- Ollama must be configured with `OLLAMA_HOST=0.0.0.0:11434` to allow Docker containers access
- Docker networking requires iptables fix on Arch Linux with kernel 6.19+
- Docker Compose file is generated by `deploy/deploy.sh`
- The Temporal workflow system manages all automation, while the Discord bot interacts with users
