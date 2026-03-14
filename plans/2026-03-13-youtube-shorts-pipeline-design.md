# YouTube Shorts Pipeline — Design Spec

**Date:** 2026-03-13
**Status:** Draft

## Overview

Automated pipeline that takes a YouTube video (via URL or local file), identifies exciting/funny moments suitable for YouTube Shorts, and produces vertical clips with styled subtitles.

Designed for gaming content — detection is tuned for loud reactions, funny commentary, and high-action gameplay moments.

## Pipeline Summary

```
!shorts <url_or_path>
  → download (yt-dlp) or validate local file
  → parallel: audio peak detection + speech transcription
  → merge peaks + transcript → LLM scores candidates
  → [optional] Gemini confirms quality + determines crop position
  → parallel child workflows: cut → subtitle → crop each clip
  → notify Discord with results
```

## Workflow Architecture

### Parent: `shortsWorkflow(source, options?)`

A Temporal workflow orchestrating the full pipeline. Accepts a YouTube URL or local file path.

**Steps:**

1. **`resolveVideo(source)`** — Download or validate, extract metadata
2. **Parallel fork:**
   - `extractAndAnalyzeAudio(videoPath)` — loudness curve → peak windows
   - `transcribeAudio(videoPath)` — word-level transcript via faster-whisper
3. **`identifyCandidates(peaks, transcript, config)`** — Ollama scores transcript segments overlapping audio peaks
4. **`confirmWithGemini(candidates, videoPath)`** *(optional, configurable)* — quality gate + crop position detection
5. **Fan-out:** spawn `clipWorkflow` child workflow per approved candidate (parallel)
6. **`notifyDiscord(results)`** — post summary + thumbnails to Discord

### Child: `clipWorkflow(videoPath, candidate)`

Processes a single clip. Runs independently with its own retry policy.
Workflow ID: `clip-<parentWorkflowId>-<clipIndex>` (deterministic, unique).

**Steps:**

1. `generateSubtitles(words, start, end)` — build ASS file from word timestamps
2. `processClip(videoPath, start, end, assPath, cropPosition)` — single FFmpeg pass: seek + crop + scale + subtitle burn-in

## Activity Details

### `resolveVideo(source: string) → VideoMeta`

- **If URL:** `yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]" -o <workspace>/%(id)s.%(ext)s <url>`
- **If local path:** verify file exists
- **Always:** `ffprobe -v quiet -print_format json -show_format -show_streams <path>`
- **Returns:** `{ path, duration, width, height, title }`
- **Retry:** 2 attempts, 5s initial backoff (network downloads can fail)
- **Timeout:** 30 minutes (`startToCloseTimeout`)
- **Heartbeat:** every 30s (yt-dlp progress parsing)
- **Aspect ratio guard:** If source video is already vertical (width/height <= 9/16), the pipeline skips the crop step and only applies subtitle burn-in and scaling.

### `extractAndAnalyzeAudio(videoPath: string) → AudioPeak[]`

- Run FFmpeg with `astats` filter to produce per-frame RMS levels:
  ```
  ffmpeg -i video.mp4 -vn -af "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level" -f null -
  ```
- Parse stderr for timestamped RMS values
- Apply rolling average (~1s window) to smooth micro-spikes
- Find peaks above configured threshold (default: -20 dB)
- Cluster peaks within 10s of each other into highlight windows
- Expand each window to 30–60s centered on peak cluster
- **Returns:** `{ start, end, peakDb, peakTimestamp }[]`
- **Retry:** 1 attempt (deterministic local operation)
- **Timeout:** 15 minutes
- **Heartbeat:** 30s (parse FFmpeg progress from stderr)

### `transcribeAudio(videoPath: string) → TranscriptWord[]`

- Extract mono 16kHz WAV: `ffmpeg -i video.mp4 -vn -ar 16000 -ac 1 -f wav audio.wav`
- Call faster-whisper via Python wrapper:
  ```
  python3 scripts/transcribe.py <audio_path> --model large-v3 --language en
  # stdout: JSON array of { "start": float, "end": float, "word": string }
  # stderr: progress/log messages
  # exit 0 on success, non-zero on failure
  ```
- Model and language passed from config via CLI args
- **Returns:** full word-level transcript
- **Retry:** 2 attempts, 5s initial backoff (model loading can occasionally fail)
- **Timeout:** 2 hours (`startToCloseTimeout` — large-v3 on CPU is ~2x real-time)
- **Heartbeat:** every 60s — activity reads `transcribe.py` stderr line-by-line and calls `Context.current().heartbeat()` on each progress line

### `identifyCandidates(peaks, transcript, config) → Candidate[]`

- For each audio peak window, extract overlapping transcript text
- Build Ollama prompt:
  > "You are analyzing a gaming video transcript. For each segment below, rate how exciting or funny it would be as a YouTube Short (1-10). Respond as JSON array with fields: segmentIndex, score, reason."
- Send segments in batches (max 10 per prompt) to stay within context limits. Merge results across batches.
- Uses the `default` model from config (or a dedicated `shorts.scoring_model` override if set)
- Combine audio peak intensity + LLM excitement score into final ranking
- Sort by combined score, take top N (configurable, default 5)
- **Returns:** `{ start, end, score, reason, transcript, words[] }[]`
- **Retry:** 2 attempts, 2s initial backoff
- **Timeout:** 10 minutes

### `confirmWithGemini(candidates, videoPath) → ConfirmedCandidate[]`

- For each candidate, extract ~2min clip around the window (stream copy for speed)
- Upload to Gemini Files API
- Prompt:
  > "This is a gaming clip. Answer as JSON: (1) Is this moment exciting or funny enough for a YouTube Short? (confirmed: boolean) (2) Where is the main action in the frame? (actionPosition: 'left' | 'center-left' | 'center' | 'center-right' | 'right') (3) Is there a facecam visible, and where? (facecamPosition: string | null) (4) Suggested crop x-offset as a fraction 0.0–1.0 where 0=left edge, 1=right edge (cropOffset: number)"
- Filter out candidates where `confirmed === false`
- **Returns:** confirmed candidates with crop positioning data
- Processes all candidates within a single activity invocation (loop internally)
- **Retry:** 3 attempts, 5s initial backoff (network API)
- **Timeout:** 30 minutes (upload + inference for up to 5 candidates)
- **Heartbeat:** 60s (heartbeat after each candidate completes)

### `generateSubtitles(words, start, end) → assPath`

- Filter transcript words to clip time range, adjust timestamps to clip-relative (subtract `start`)
- Generate ASS file with configured styling (see Subtitle Styling section)
- Group words into phrases using speech pauses (gaps > 300ms between words) as natural break points, falling back to 2–4 words per line when speech is continuous
- **Retry:** 1 attempt (deterministic)
- **Timeout:** 1 minute

### `processClip(videoPath, start, end, assPath, cropPosition) → outputPath`

Single FFmpeg command that seeks into the source, extracts the segment, crops, scales, and burns subtitles — all in one pass to avoid double re-encoding:

```
ffmpeg -ss <start> -to <end> -i video.mp4 \
  -vf "crop=ih*9/16:ih:<x_offset>:0,scale=1080:1920,ass=subtitles.ass" \
  -c:v libx264 -crf 18 -c:a aac -b:a 192k \
  output.mp4
```
- `x_offset` calculated from Gemini's `cropOffset` fraction: `x = cropOffset * (iw - ow)`
- Falls back to center crop if Gemini is disabled
- If source is already vertical, skips crop and only applies scale + subtitles
- Output: 1080x1920 vertical video with burned-in subtitles
- **Retry:** 1 attempt
- **Timeout:** 10 minutes
- **Heartbeat:** 30s (parse FFmpeg progress from stderr)

### `notifyDiscord(results) → void`

- Extract a thumbnail frame from each clip at peak moment: `ffmpeg -ss <peak> -i clip.mp4 -frames:v 1 thumb.jpg`
- Post to configured Discord channel (`shorts` by default):
  - Summary: clip count, source video title
  - Per clip: thumbnail attachment, duration, transcript snippet, excitement score, output file path
- **Retry:** 2 attempts, 2s initial backoff
- **Timeout:** 2 minutes

### `reportProgress(message) → void`

- Posts interim status updates to the Discord channel during long-running operations
- Called between major steps: "Downloading video...", "Transcription complete, analyzing 23 candidate moments...", "Processing 5 clips..."
- Uses the same Discord client dependency injection as `notifyDiscord`
- **Retry:** 1 attempt (best-effort, non-critical)
- **Timeout:** 30 seconds

## Subtitle Styling

Bold centered captions in MrBeast/TikTok style using ASS format.

### ASS Header

```
[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Impact,72,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,0,2,10,10,80,1
```

### Key Style Properties

| Property | Value | Effect |
|----------|-------|--------|
| Font | Impact | Heavy, blocky, universally available |
| Size | 72 (at 1080x1920 PlayRes) | Large, readable on mobile |
| PrimaryColour | `&H00FFFFFF` | White text |
| OutlineColour | `&H00000000` | Black outline |
| Bold | -1 (on) | Bold weight |
| Outline | 4 | Thick black border |
| Alignment | 2 | Bottom-center |
| MarginV | 80 | Vertical margin from bottom |

### Dialogue Lines

Short phrases (2–4 words per line) timed to word boundaries:

```
Dialogue: 0,0:00:01.20,0:00:02.10,Default,,0,0,0,,OH MY GOD
Dialogue: 0,0:00:02.10,0:00:03.05,Default,,0,0,0,,DID YOU SEE THAT
```

All text uppercased for the Shorts aesthetic. Configurable via `config.toml`.

## Configuration

### New `config.toml` section

```toml
[shorts]
workspace_dir = "/var/lib/ai-hub/shorts"
max_clips = 5
min_clip_duration = 15
max_clip_duration = 58
peak_threshold = -20
output_channel = "shorts"
scoring_model = ""           # optional override; uses models.default if empty

[shorts.gemini]
enabled = true
api_key_env = "GEMINI_API_KEY"
model = "gemini-2.5-flash"

[shorts.transcription]
model = "large-v3"
language = "en"

[shorts.subtitles]
font = "Impact"
font_size = 72
primary_color = "&H00FFFFFF"
outline_color = "&H00000000"
outline_width = 4
alignment = 2
margin_v = 80
uppercase = true
```

### Integration with existing `Config` type

The `shorts` field is **optional** on the `Config` interface — existing deployments without it continue to work. The `!shorts` command checks for config presence and replies with an error if unconfigured.

```typescript
// In types.ts — add to existing Config interface:
interface Config {
  discord: DiscordConfig;
  models: ModelsConfig;
  schedule: ScheduleConfig;
  email: EmailConfig;
  shorts?: ShortsConfig;  // optional
}
```

At startup in `loadConfig()`: if `config.shorts?.gemini.enabled`, validate that the env var from `config.shorts.gemini.api_key_env` is set. Skip validation entirely if `shorts` is absent.

### TypeScript Interfaces (additions)

```typescript
interface ShortsConfig {
  workspace_dir: string;
  max_clips: number;
  min_clip_duration: number;
  max_clip_duration: number;
  peak_threshold: number;
  output_channel: string;
  scoring_model: string;
  gemini: GeminiConfig;
  transcription: TranscriptionConfig;
  subtitles: SubtitleConfig;
}

interface GeminiConfig {
  enabled: boolean;
  api_key_env: string;
  model: string;
}

interface TranscriptionConfig {
  model: string;
  language: string;
}

interface SubtitleConfig {
  font: string;
  font_size: number;
  primary_color: string;
  outline_color: string;
  outline_width: number;
  alignment: number;
  margin_v: number;
  uppercase: boolean;
}
```

## Discord Integration

### Command

```
!shorts <url_or_path> [--max-clips N] [--no-gemini] [--threshold N]
```

- Parsed in `router.ts` alongside existing `!rgb` command pattern
- Starts `shortsWorkflow` via Temporal client with unique workflow ID `shorts-<messageId>`
- Bot replies immediately: "Processing started — I'll post results to #shorts when done"
- Final results posted to configured output channel

### Discord Handler Pattern

The bot uses `temporalClient.workflow.start()` (fire-and-forget), **not** `.workflow.execute()`, because the pipeline runs for minutes to hours. The handler immediately replies with an acknowledgment and returns.

```typescript
// In bot.ts message handler:
const shortsCmd = parseShortsCommand(content);
if (shortsCmd) {
  await temporalClient.workflow.start(shortsWorkflow, {
    workflowId: `shorts-${message.id}`,
    taskQueue: 'firefly-ai-hub',
    args: [shortsCmd.source, shortsCmd.options],
  });
  await message.reply("Processing started -- I'll post results to #shorts when done");
  return;
}
```

The workflow itself posts results via `notifyDiscord` and `reportProgress` activities (using the same Discord client injection pattern as existing activities).

### New Route

`parseRgbCommand` pattern extended with `parseShortsCommand(content)` returning `{ source, options }`.

## File Structure

### New source files

```
hub/src/shorts/
├── types.ts           — VideoMeta, AudioPeak, Candidate, ClipResult, etc.
├── audio-analysis.ts  — FFmpeg astats parsing, peak detection, clustering
├── transcription.ts   — faster-whisper subprocess wrapper
├── candidates.ts      — Ollama prompt building, candidate scoring/merging
├── gemini.ts          — Gemini Files API: upload, analyze, parse crop position
├── clip-processing.ts — FFmpeg single-pass: seek + crop + scale + subtitle burn-in
├── subtitles.ts       — ASS file generation from word timestamps
└── ffprobe.ts         — Video metadata extraction via ffprobe

hub/scripts/
└── transcribe.py      — faster-whisper CLI wrapper (JSON output to stdout)
```

### Workflow and activity registration

- New workflows (`shortsWorkflow`, `clipWorkflow`) added to `temporal/workflows.ts`
- New activities registered in `temporal/activities.ts` alongside existing ones
- Same task queue (`firefly-ai-hub`), same worker

## Workspace Layout

Each invocation creates an isolated workspace:

```
<workspace_dir>/
└── <video_id_or_hash>/
    ├── source.mp4
    ├── audio.wav
    ├── transcript.json
    ├── candidates.json
    ├── clip_001/
    │   ├── subtitles.ass
    │   └── final.mp4
    ├── clip_002/
    │   └── ...
    └── thumbnails/
        ├── clip_001.jpg
        └── clip_002.jpg
```

Intermediate files (audio.wav, raw.mp4) can be cleaned up after successful processing. Source video retained for re-processing.

## Dependencies

### System packages (must be installed on host/container)

| Package | Purpose |
|---------|---------|
| `yt-dlp` | YouTube video download |
| `ffmpeg` / `ffprobe` | Audio analysis, clip cutting, crop, subtitle burn-in, thumbnails |
| `python3` + `faster-whisper` | Local speech-to-text with word-level timestamps |

### npm packages (new)

| Package | Purpose |
|---------|---------|
| `@google/genai` | Gemini API SDK for video analysis |

### Python packages

| Package | Purpose |
|---------|---------|
| `faster-whisper` | CTranslate2-based Whisper for fast local transcription |

## Retry Policies

| Activity | Max Attempts | Backoff | Timeout | Heartbeat |
|----------|-------------|---------|---------|-----------|
| resolveVideo | 2 | 5s | 30m | 30s |
| extractAndAnalyzeAudio | 1 | — | 15m | 30s |
| transcribeAudio | 2 | 5s | 2h | 60s |
| identifyCandidates | 2 | 2s | 10m | — |
| confirmWithGemini | 3 | 5s | 30m | 60s |
| generateSubtitles | 1 | — | 1m | — |
| processClip | 1 | — | 10m | 30s |
| reportProgress | 1 | — | 30s | — |
| notifyDiscord | 2 | 2s | 2m | — |

Activities with heartbeats should call `Context.current().heartbeat()` periodically. This lets Temporal distinguish "still running" from "hung" and enables faster detection of worker crashes.

## Worker Concurrency

Shorts activities are CPU/IO-heavy (FFmpeg, Whisper) unlike existing lightweight activities (Ollama HTTP calls, IMAP fetch). To prevent a long-running shorts pipeline from starving other workflows (email triage, chat), the worker should set `maxConcurrentActivityTaskExecutions` to a reasonable value (e.g., 4). This lets multiple clip processing activities run in parallel while still leaving capacity for other work.

If concurrency becomes an issue in practice, a future improvement would be a dedicated `shorts` task queue with its own worker.

## Error Handling

- **yt-dlp failure:** Workflow fails with descriptive error, bot notifies user in Discord
- **Transcription failure:** Workflow continues with audio-only analysis (degraded but functional)
- **Ollama unavailable:** Workflow fails, bot posts "Model unavailable" (same as existing chat error pattern)
- **Gemini failure (if enabled):** Falls back to center crop, logs warning, continues processing
- **FFmpeg failure in child workflow:** Child workflow retries per policy; if exhausted, parent collects partial results and notifies which clips failed
- **No candidates found:** Bot notifies user "No exciting moments detected — try adjusting the threshold"
- **Failed workspaces:** Left in place for debugging. Partial downloads/intermediates remain on disk. Manual cleanup via filesystem or a future `!shorts-cleanup` command.

## Open Questions

1. **Whisper model size vs speed:** `large-v3` gives best accuracy but is slowest (~2x real-time on CPU for a 2-hour video = ~1 hour). `medium` is ~5x faster with ~2% lower accuracy. Default to `large-v3` but make configurable.
2. **Cleanup policy:** Auto-delete workspace after N days? Or manual cleanup via Discord command? Start with manual, add later.
3. **GPU acceleration:** faster-whisper and FFmpeg both support CUDA. Worth enabling if an NVIDIA GPU is available. Configurable but not required.
