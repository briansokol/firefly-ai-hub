# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

## Working Conventions

- Plans go in the `plans/` folder before implementation begins
- Keep plans and their corresponding code co-located or clearly cross-referenced

## Key Files

- `plans/tasks.md` — Active task list with current progress (checked = done)
- `plans/2026-02-27-ai-hub-architecture-design.md` — Full architecture plan and deployment order

## YouTube Shorts Pipeline

The shorts system automatically finds viral-worthy moments in YouTube videos, extracts clips, and posts them to Discord.

### Discord Commands
- `!shorts <URL>` — Start full analysis pipeline for a video
- `!shorts-edit <workspace-name>` — Re-process clips from checkpoint (skips detection, re-renders clips)
  - Accepts just the folder name (e.g. `my-cool-video`), resolved against `workspace_dir`
  - Also accepts absolute paths for backwards compatibility

### Pipeline Steps (shortsAnalysisWorkflow)
1. **Download & workspace creation** — yt-dlp download, workspace named from slugified video title (everything before `|`)
2. **Audio extraction + transcription** (parallel) — FFmpeg → WAV, faster-whisper → word-level timestamps
3. **Audio analysis** (parallel) — loudness peaks (ebur128), YAMNet event classification (laughter/cheering), parselmouth prosody (pitch/energy)
4. **Candidate scoring** — sliding-window LLM scoring via Ollama, optional two-pass with screening model
5. **Hosted AI confirmation** (optional) — Gemini (video) or Claude (keyframe) re-scores, determines crop position
6. **Checkpoint save** — `checkpoint.json` for `!shorts-edit` resume
7. **Clip processing** (parallel) — boundary snapping to speech gaps, 9:16 crop, subtitle burn-in, libx264 CRF 18
8. **Discord notification** — posts clips (<25MB) or NAS paths, workspace name for re-editing
9. **Cleanup** — removes intermediates, keeps source video, final clips, and checkpoint

### Key Source Files
| File | Purpose |
|------|---------|
| `hub/src/shorts/workflow.ts` | Temporal workflow orchestration (main + edit) |
| `hub/src/shorts/candidates.ts` | Sliding-window LLM scoring, deduplication, diversity enforcement |
| `hub/src/shorts/hosted-scoring.ts` | Gemini/Claude confirmation with video/image understanding |
| `hub/src/shorts/clip-processing.ts` | FFmpeg clip extraction, 9:16 cropping, subtitle burn-in |
| `hub/src/shorts/subtitles.ts` | ASS subtitle generation (phrase grouping, styling) |
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

### Workspace Structure
```
{workspace_dir}/{slugified-title}/
├── source.mp4          # Downloaded video (kept)
├── audio.wav           # Extracted audio (cleaned up)
├── transcript.json     # Word-level transcript
├── audio_events.json   # YAMNet results
├── prosody.json        # Pitch/energy per second
├── checkpoint.json     # Resume state for !shorts-edit
├── clip_001/
│   ├── subtitles.ass   # Generated ASS subtitles
│   └── final.mp4       # Processed 9:16 clip (kept)
└── clip_NNN/...
```

### External Dependencies
- **yt-dlp** — video download
- **ffmpeg/ffprobe** — audio extraction, video processing, metadata
- **faster-whisper** (Python) — transcription
- **YAMNet/TFLite** (Python) — audio event classification
- **parselmouth** (Python) — pitch/prosody analysis
- **Ollama** (local) — candidate scoring and title generation
- **Google Gemini / Anthropic Claude** (optional) — hosted AI clip confirmation

### Configuration
Shorts config lives in `config.toml` under `[shorts]`. Key fields:
- `workspace_dir` — root path for all workspaces
- `max_clips` — max candidates to keep
- `scoring_model` / `screening_model` — Ollama models (two-pass if both set)
- `window_size` / `window_overlap` — sliding window params (default 30s/15s)
- `min_clip_duration` / `max_clip_duration` — clip bounds (default 15s/58s)
- `subtitles.*` — font, size, colors, alignment, margin_v (650 = ~66% from top on 1920px)
- `hosted_scoring.*` — provider (google/anthropic), model, API key env var

## Session Continuity

- Use `/ai-hub-resume` at the start of any session to orient to current task list state
- Tasks use `- [x]` / `- [ ]` checkboxes; completed sections are marked with ✓ in the header
- User confirms completion of each task before moving to the next — don't skip ahead
