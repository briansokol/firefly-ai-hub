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
- `wiki/` — LLM-maintained knowledge base (sources, pages, index, log)
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
- `MEMORY_API_TOKEN` – Shared secret (X-Auth) for the web tools HTTP API on :8787 (consumed by the Open WebUI `hub_web_tools.py` filter). Required at startup.
- `LITELLM_MASTER_KEY` – Master key for the LiteLLM gateway on :4000. Set in `/etc/ai-hub/hub.env`.
- `ANTHROPIC_API_KEY` – Cloud key for the `frontier` fallback. Left blank for now (fallback not wired in).
- `SYNC_API_TOKEN` – Bearer token for the sync API on :8788 (app clients). Required at startup.
- `SYNC_DB_URL` – Postgres URL for the sync service (default DB `firefly_sync`, created on boot). Required at startup.
- `QDRANT_URL` – Qdrant base URL for memory vectors (default: `http://localhost:6333`)
- `CONFIG_PATH` – Override config file location (default: `/opt/ai-hub/config.toml`)
- `STATE_DIR` – Override state database directory (default: `~/.local/share/firefly-ai-hub`)
- `TEMPORAL_ADDRESS` – Override Temporal client address (default: `localhost:7233`)

## Memory system

The old SQLite + FTS5 explicit-trigger memory (and its Discord and Open WebUI integrations) has been **removed**. It is replaced by a distilled-memory engine that serves the multi-device app clients only (not Discord or Open WebUI):

- A Temporal scheduled workflow distills synced conversations into durable facts/preferences, embeds them via Ollama, and stores them in Postgres (`firefly_sync` DB) + Qdrant.
- App clients query memories via the sync service's `/memories/search` endpoint.
- See `PLAN-firefly-upgrade.md` and the sync service under `hub/src/sync/`.

## Web tools HTTP API

The `ai-hub` container exposes a small HTTP server (`hub/src/web/http.ts`) on port 8787, bound `http://ai-hub:8787` on the compose network. It serves `/web/search` (Brave) and `/web/fetch` (URL → text), guarded by the `MEMORY_API_TOKEN` shared secret via the `X-Auth` header. Consumed by the Open WebUI `deploy/open-webui/functions/hub_web_tools.py` Tool.

## Important Notes

- Ollama must be configured with `OLLAMA_HOST=0.0.0.0:11434` to allow Docker containers access
- Docker networking requires iptables fix on Arch Linux with kernel 6.19+
- Docker Compose file is generated by `deploy/deploy.sh`
- The Temporal workflow system manages all automation, while the Discord bot interacts with users

## LLM Wiki

The `wiki/` directory is an LLM-maintained personal knowledge base. The LLM owns all generated content in `wiki/pages/` and the control files (`wiki/index.md`, `wiki/log.md`, `wiki/overview.md`). Files in `wiki/sources/` are immutable — read but never modify.

### Directory Layout

| Path | Owner | Purpose |
|------|-------|---------|
| `wiki/sources/` | Human | Raw source documents. Subdirs: `articles/`, `papers/`, `notes/`, `transcripts/`. Never modified by the LLM. |
| `wiki/pages/` | LLM | Generated wiki pages. Subdirs: `summaries/`, `entities/`, `concepts/`, `comparisons/`, `syntheses/`. |
| `wiki/index.md` | LLM | Content catalog of all wiki pages, organized by category, with wikilinks and one-line descriptions. |
| `wiki/log.md` | LLM | Append-only chronological log of all operations (newest first). |
| `wiki/overview.md` | LLM | High-level narrative overview of the knowledge base's contents and themes. |

### Page Format

Every file in `wiki/pages/` MUST have YAML frontmatter:

```yaml
---
title: "Page Title"
type: summary | entity | concept | comparison | synthesis
sources:
  - "sources/articles/some-article.md"
created: 2026-04-15
updated: 2026-04-15
tags:
  - tag1
  - tag2
---
```

Body conventions:
- Use Obsidian-compatible wikilinks: `[[Page Title]]` to link to other wiki pages
- Use `[[Page Title|display text]]` for aliased links
- Source references use relative paths: `[source](../sources/articles/foo.md)`
- Each page opens with a one-paragraph lead summarizing its content
- Use H2 (`##`) for top-level sections within a page; H1 is the page title only
- Comparisons must include a summary table
- Summaries must link back to their source document

### Operations

#### Ingest

Trigger: User provides a new source document or asks to ingest a file in `wiki/sources/`.

Steps:
1. Read the source document completely
2. Create or update `wiki/pages/summaries/<source-slug>.md` with a structured summary
3. Identify entities, concepts, and relationships mentioned in the source
4. For each significant entity/concept: create a new page in the appropriate subdir, or update the existing page with information from the new source (add the source to its `sources` frontmatter list)
5. If the new source relates to existing pages, update those pages with cross-references
6. Update `wiki/index.md` — add new pages, update descriptions if they changed
7. Update `wiki/overview.md` if the new source shifts the knowledge base's themes
8. Append to `wiki/log.md` (newest first):
   ```
   ## YYYY-MM-DD — Ingest: <source filename>
   - Created: <list of new pages>
   - Updated: <list of updated pages>
   - Source: `sources/<path>`
   ```

#### Query

Trigger: User asks a question and wants the wiki consulted.

Steps:
1. Read `wiki/index.md` and relevant `wiki/pages/` files to find pertinent content
2. Synthesize an answer from wiki content, citing specific pages with wikilinks
3. If the answer is substantial and reusable, offer to save it as a new page (comparison or synthesis)
4. If saving a new page, run the index/log update steps from Ingest

#### Lint

Trigger: User asks to lint/health-check the wiki.

Checks:
1. **Orphans** — pages in `wiki/pages/` not listed in `wiki/index.md`
2. **Dead links** — wikilinks pointing to non-existent pages
3. **Stale claims** — pages whose `updated` date is >90 days old (flag for review)
4. **Missing cross-references** — pages that share tags or sources but don't link to each other
5. **Frontmatter validation** — every page has required fields (`title`, `type`, `sources`, `created`, `updated`, `tags`)
6. **Source coverage** — files in `wiki/sources/` with no corresponding summary in `wiki/pages/summaries/`

Output: Print findings to the user AND append a lint report to `wiki/log.md`.

### Naming Conventions

- Page filenames: lowercase kebab-case, e.g., `retrieval-augmented-generation.md`
- Summary filenames mirror source: if source is `sources/papers/attention-is-all-you-need.md`, summary is `pages/summaries/attention-is-all-you-need.md`
- Wikilinks use the page title (from frontmatter), not the filename
