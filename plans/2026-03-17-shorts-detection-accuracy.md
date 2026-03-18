# Improve Shorts Clip Detection Accuracy

**Date:** 2026-03-17
**Status:** Draft
**Hosted AI preference:** Claude API (Anthropic)

## Context

The current shorts pipeline identifies "shorts-worthy" moments using two signals: audio loudness peaks (FFmpeg ebur128) and LLM-scored transcript segments (Ollama). This works but has limitations:

- **Text-only LLM scoring** — the model can't hear tone, laughter, or excitement in voice
- **No visual analysis** — misses visual gags, impressive gameplay, on-screen drama
- **Flat prompting** — no system prompt, no scoring rubric, no audio metadata in context
- **Single-pass scoring** — every segment gets equal evaluation effort, no refinement pass
- **No feedback loop** — no way to learn which clips users actually liked

The goal is to significantly improve detection accuracy while keeping the pipeline primarily local, using hosted AI (Claude API) where it provides meaningful gains.

---

## Phase 1: Better Signals from Existing Data (Local, No New Dependencies)

These changes extract more information from data we already collect (transcript + audio peaks) and improve how the LLM uses it.

### 1.1 — Derived Audio Features

**New file:** `hub/src/shorts/audio-features.ts`

Compute per-second features from existing transcript + peaks data (no new subprocess):

| Feature | How | Why |
|---------|-----|-----|
| Speech rate | words/sec from transcript timestamps | People talk faster when excited |
| Volume delta | Current LUFS - 10s rolling average | Sudden loud-after-quiet = dramatic |
| Silence-to-loud | Gap >1.5s followed by loudness spike | Punchlines, jump scares |
| Speech density | Overlapping/rapid word timestamps | Excited group reactions, arguments |

Create `computeAudioFeatures(peaks, transcript)` that returns a `Map<secondTimestamp, FeatureVector>`. These features get summarized and injected into the LLM prompt as metadata.

### 1.2 — Enhanced LLM Prompts

**Modify:** `hub/src/shorts/candidates.ts`

1. **Add a system prompt** with a scoring rubric:
   - 1-3: mundane, filler, routine gameplay
   - 4-6: mildly interesting, decent moment
   - 7-8: compelling, would make someone stop scrolling
   - 9-10: viral-worthy, genuinely hilarious or jaw-dropping

2. **Include audio feature metadata** in each scoring prompt:
   > "Audio context: speaker volume is 8dB above average, speech rate 4.2 words/sec (avg: 2.8), follows a 2.1s silence"

3. **Include video title** for genre context:
   > "This is from a video titled 'Valorant Ranked Grind Session'"

4. **Structured output with reasoning** — change response format to:
   ```json
   {"reasoning": "...", "score": 7, "quote": "...", "category": "humor|action|dramatic|story"}
   ```
   Chain-of-thought before the score improves accuracy. Category enables diversity enforcement later.

### 1.3 — Two-Pass Scoring

**Modify:** `hub/src/shorts/candidates.ts`, `hub/src/types.ts`

- **Pass 1 (screening):** Score all windows/peaks with a fast local model (e.g. `llama3.2:3b` or `phi4-mini`). Simple prompt, just get a 1-10 score.
- **Pass 2 (evaluation):** Take top ~2× desired clips (e.g. top 10 if you want 5). Re-score with the full model using enhanced prompts from 1.2, plus expanded context (what comes before/after).

Add `screening_model` to `ShortsConfig`. If empty, skip two-pass and use `scoring_model` for everything (backward compatible).

### 1.4 — Candidate Diversity Enforcement

**Modify:** `hub/src/shorts/candidates.ts`

After deduplication by time proximity, ensure category diversity in final selection:
- Use the `category` field from structured output
- Don't let all clips be the same type (e.g. all "action" with no "humor")
- Simple heuristic: if >60% of clips share a category, swap the lowest-scoring duplicate for the highest-scoring clip from an underrepresented category

**Files touched in Phase 1:**
- `hub/src/shorts/audio-features.ts` (new)
- `hub/src/shorts/candidates.ts` (major changes)
- `hub/src/shorts/types.ts` (new interfaces: `FeatureVector`, `EnrichedCandidate`)
- `hub/src/types.ts` (add `screening_model` to `ShortsConfig`)

---

## Phase 2: Laugh & Reaction Detection (Local, New Python Dependency)

### 2.1 — Audio Event Classification with YAMNet

**New file:** `hub/scripts/audio_classify.py`

Use Google's [YAMNet](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet) (TensorFlow Lite, ~14MB model) to classify audio events. It detects 521 AudioSet classes including:
- Laughter, giggling
- Cheering, shouting, screaming
- Applause
- Gasp, sigh

**Implementation:**
- Input: `audio.wav` (already extracted by existing pipeline)
- Process in 960ms frames, output timestamped events with confidence scores
- Filter to relevant classes (laughter, cheering, screaming, etc.) above 0.5 confidence
- Output: JSON array `[{timestamp, event, confidence}]`

**Integration:** Add laugh/reaction scores to the feature vector from Phase 1. Include in LLM prompt context: "Audio events: laughter detected at 0.82 confidence"

**New dependency:** `tensorflow-lite` or `tflite-runtime` (lightweight, ~5MB). YAMNet model auto-downloads on first run.

### 2.2 — Speech Prosody (Pitch Analysis)

**New file:** `hub/scripts/prosody.py`

Use `parselmouth` (Python Praat wrapper) to extract pitch contours:
- Mean pitch per second and pitch variance
- Pitch rises (excitement marker) vs. drops
- Energy relative to speaker baseline

This captures *how* something is said, not just *what* was said. A monotone "oh my god" scores differently from a screamed one.

**New dependency:** `parselmouth` (~15MB pip install)

**Files touched in Phase 2:**
- `hub/scripts/audio_classify.py` (new)
- `hub/scripts/prosody.py` (new)
- `hub/src/shorts/audio-features.ts` (integrate new signals)
- `hub/src/shorts/workflow.ts` (add new parallel activities)
- `hub/src/temporal/activities.ts` (register new activities)
- `hub/Dockerfile` (add Python dependencies)

---

## Phase 3: Claude API as Final Judge (Highest Single Accuracy Gain)

### 3.1 — Claude Sonnet for Pass 2 Scoring

The design doc already specifies an optional Gemini integration for clip confirmation. Extend this concept to scoring with Claude.

**New file:** `hub/src/shorts/hosted-scoring.ts`

For the Pass 2 finalists (~10-15 candidates):
- Send to Claude Sonnet with:
  - 60s transcript context (expanded from 30s)
  - Audio feature metadata (speech rate, volume dynamics, laugh detection results)
  - Detailed rubric prompt explaining YouTube Shorts appeal
  - Video title and genre context
- Get structured JSON with reasoning

**Why this is the biggest single win:** Claude understands humor, narrative tension, and social media virality far better than local 7B models. The local model's main weakness is misjudging *what's actually funny* vs. what just contains excitement-adjacent keywords.

**Cost:** ~15 API calls × ~500 tokens = ~10K tokens per video ≈ $0.03-0.06 per analysis.

**Config:**
```toml
[shorts.hosted_scoring]
enabled = false
provider = "anthropic"
model = "claude-sonnet-4-20250514"
api_key_env = "ANTHROPIC_API_KEY"
```

### 3.2 — Multimodal Hosted Scoring (Vision + Text)

For the top 5-8 finalists after text-based hosted scoring:
- Extract a keyframe at each candidate timestamp via FFmpeg
- Send keyframe + transcript + audio features to Claude in a single multimodal call
- The model can reason jointly: "the player screams 'NO WAY' while the kill feed shows a 1v5 ace"

Claude supports vision natively. This is an extension of 3.1, not a separate step.

**Files touched in Phase 3:**
- `hub/src/shorts/hosted-scoring.ts` (new)
- `hub/src/shorts/candidates.ts` (integrate hosted scoring into Pass 2)
- `hub/src/types.ts` (add `hosted_scoring` config)
- `hub/src/config.ts` (validate hosted scoring config)

---

## Phase 4: Visual Analysis (Local, FFmpeg-Based)

### 4.1 — Scene Change & Motion Detection

**New file:** `hub/src/shorts/video-features.ts`

Use FFmpeg filters (no ML model needed):
```bash
# Scene changes — timestamps where visual content shifts dramatically
ffmpeg -i video.mp4 -vf "select='gt(scene,0.3)',showinfo" -f null -

# Frame difference for motion intensity
ffmpeg -i video.mp4 -vf "mpdecimate" -loglevel debug -f null -
```

Produce per-10s-window metrics:
- **Scene change density** — rapid cuts correlate with action sequences
- **Motion intensity** — high frame-to-frame difference = fast-paced gameplay

Note: For gaming content with a static camera, these may be less useful than for edited content. Weight accordingly.

### 4.2 — Keyframe + Local Vision Model (Optional)

For Pass 2 finalists, extract keyframes and analyze with Ollama multimodal model (LLaVA):
```bash
ffmpeg -ss <timestamp> -i video.mp4 -vframes 1 -q:v 2 frame.jpg
```

Send to `llava:13b` via Ollama: "Describe this gaming screenshot. Is this an exciting, funny, or dramatic moment?"

**Caveat:** Current local vision models may struggle with game-specific visuals. This is lower priority than hosted multimodal scoring (Phase 3.2).

**Files touched in Phase 4:**
- `hub/src/shorts/video-features.ts` (new)
- `hub/src/shorts/workflow.ts` (add parallel video analysis activity)
- `hub/src/temporal/activities.ts` (register activity)

---

## Phase 5: Multi-Signal Fusion

### 5.1 — Weighted Signal Combination

**New file:** `hub/src/shorts/signal-fusion.ts`

Replace the current "just use LLM score" approach with a weighted combination:

```typescript
interface SignalVector {
  llmScore: number;          // Local LLM 1-10, normalized 0-1
  hostedAiScore: number;     // Hosted AI 1-10, normalized 0-1 (0 if disabled)
  loudnessPeak: number;      // LUFS normalized
  speechRate: number;        // z-score from mean
  volumeDelta: number;       // dB above rolling avg, normalized
  silenceTransition: number; // binary: was there a silence gap before?
  laughDetected: number;     // confidence 0-1 (0 if detection disabled)
  pitchExcitement: number;   // pitch rise metric, normalized
  sceneChangeDensity: number;// per 10s, normalized (0 if disabled)
}
```

**Initial weights** (hand-tuned, refined via feedback later):

| Signal | Weight | Notes |
|--------|--------|-------|
| hostedAiScore | 0.30 | Best single signal (redistributed to local if disabled) |
| llmScore | 0.20 | Good baseline |
| laughDetected | 0.12 | Direct humor signal |
| speechRate | 0.10 | Excitement indicator |
| volumeDelta | 0.10 | Dramatic moments |
| pitchExcitement | 0.08 | Genuine excitement vs monotone |
| loudnessPeak | 0.05 | Raw loudness (already captured by delta) |
| silenceTransition | 0.03 | Punchlines, reveals |
| sceneChangeDensity | 0.02 | Weak for gaming |

---

## Phase 6: Feedback Loop (Future)

### 6.1 — Discord Reaction Tracking

Modify `notifyDiscord` to add thumbs up/down reactions. Collect user feedback and store as JSON. Over time, use feedback to calibrate signal weights.

Not detailed here — this is a future enhancement once the core detection is improved.

---

## Implementation Order (Prioritized)

| # | Item | Impact | Effort | Type |
|---|------|--------|--------|------|
| 1 | Phase 1.2: Enhanced LLM prompts | High | Low | Local |
| 2 | Phase 1.1: Derived audio features | Med-High | Low | Local |
| 3 | Phase 1.3: Two-pass scoring | Medium | Low-Med | Local |
| 4 | Phase 1.4: Diversity enforcement | Low-Med | Low | Local |
| 5 | Phase 3.1: Claude API final judge | High | Medium | Hosted |
| 6 | Phase 2.1: Laugh detection (YAMNet) | Med-High | Medium | Local |
| 7 | Phase 5.1: Signal fusion | Medium | Medium | Local |
| 8 | Phase 2.2: Pitch/prosody analysis | Medium | Medium | Local |
| 9 | Phase 4.1: Scene change/motion | Low-Med | Medium | Local |
| 10 | Phase 3.2: Multimodal hosted scoring | High | Medium | Hosted |
| 11 | Phase 4.2: Local vision model | Low-Med | Medium | Local |
| 12 | Phase 6.1: Feedback loop | Low→High | Medium | Local |

**Recommended first PR:** Items 1-4 (Phase 1 complete). No new dependencies, biggest immediate improvement.
**Second PR:** Items 5-7 (Claude API scoring + laugh detection + fusion).

---

## Verification

After each phase, test by running the pipeline on 2-3 known gaming videos where you already know which moments are good:

1. Run `!shorts <url>` on a video with known funny/exciting moments
2. Compare detected candidates against your manual picks
3. Check that scores reflect actual clip quality (high scores = genuinely good moments)
4. Verify diversity — not all clips should be the same type
5. For hosted AI: compare Pass 2 hosted scores vs local-only scores on the same finalists
