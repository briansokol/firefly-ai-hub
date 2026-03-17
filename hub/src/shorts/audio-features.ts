import type { AudioPeak, TranscriptWord, FeatureVector, AudioFeatureSummary } from './types.js';

const ROLLING_AVG_WINDOW = 10; // seconds for rolling LUFS average
const SILENCE_GAP_THRESHOLD = 1.5; // seconds of silence before a loud moment
const SPEECH_DENSITY_WINDOW = 3; // seconds for measuring rapid speech bursts

/**
 * Compute per-second audio features from existing peaks and transcript data.
 * No new subprocesses — purely derived from data the pipeline already collects.
 */
export function computeAudioFeatures(
  peaks: AudioPeak[],
  transcript: TranscriptWord[],
): Map<number, FeatureVector> {
  const features = new Map<number, FeatureVector>();
  if (peaks.length === 0 && transcript.length === 0) return features;

  // Determine time range from both sources
  const maxTime = Math.ceil(Math.max(
    peaks.length > 0 ? peaks[peaks.length - 1].timestamp : 0,
    transcript.length > 0 ? transcript[transcript.length - 1].end : 0,
  ));

  // Pre-index peaks by second for fast lookup
  const peakBySecond = new Map<number, number>();
  for (const p of peaks) {
    const sec = Math.floor(p.timestamp);
    const existing = peakBySecond.get(sec);
    if (existing === undefined || p.rms > existing) {
      peakBySecond.set(sec, p.rms);
    }
  }

  for (let t = 0; t <= maxTime; t++) {
    features.set(t, {
      speechRate: computeSpeechRate(transcript, t),
      volumeDelta: computeVolumeDelta(peakBySecond, t),
      silenceToLoud: detectSilenceToLoud(transcript, peakBySecond, t),
      speechDensity: computeSpeechDensity(transcript, t),
    });
  }

  return features;
}

/** Words per second in a 1-second bucket centered on `t`. */
function computeSpeechRate(transcript: TranscriptWord[], t: number): number {
  let count = 0;
  for (const w of transcript) {
    if (w.start >= t && w.start < t + 1) count++;
  }
  return count;
}

/** Current LUFS minus 10-second rolling average. Positive = louder than recent context. */
function computeVolumeDelta(peakBySecond: Map<number, number>, t: number): number {
  const current = peakBySecond.get(t);
  if (current === undefined) return 0;

  let sum = 0;
  let count = 0;
  const start = Math.max(0, t - ROLLING_AVG_WINDOW);
  for (let s = start; s < t; s++) {
    const val = peakBySecond.get(s);
    if (val !== undefined) {
      sum += val;
      count++;
    }
  }

  if (count === 0) return 0;
  return current - sum / count;
}

/** True if there's a silence gap >1.5s followed by a loudness spike at time `t`. */
function detectSilenceToLoud(
  transcript: TranscriptWord[],
  peakBySecond: Map<number, number>,
  t: number,
): boolean {
  // Need a peak at this second
  if (!peakBySecond.has(t)) return false;

  // Check for a speech gap before this moment
  const gapStart = t - SILENCE_GAP_THRESHOLD;
  const hasRecentSpeech = transcript.some(
    (w) => w.end >= gapStart && w.end <= t && w.start >= gapStart,
  );

  return !hasRecentSpeech;
}

/** Word density in a tight window — high values indicate rapid speech / excited group reactions. */
function computeSpeechDensity(transcript: TranscriptWord[], t: number): number {
  const start = t - SPEECH_DENSITY_WINDOW / 2;
  const end = t + SPEECH_DENSITY_WINDOW / 2;
  let count = 0;
  for (const w of transcript) {
    if (w.start >= start && w.start < end) count++;
  }
  return count / SPEECH_DENSITY_WINDOW;
}

/**
 * Summarize features for a time window (e.g. a 30s scoring window).
 * Returns a summary suitable for injecting into LLM prompts.
 */
export function summarizeFeaturesForWindow(
  features: Map<number, FeatureVector>,
  windowStart: number,
  windowEnd: number,
): AudioFeatureSummary {
  const start = Math.floor(windowStart);
  const end = Math.ceil(windowEnd);

  let sumSpeechRate = 0;
  let peakSpeechRate = 0;
  let sumVolumeDelta = 0;
  let peakVolumeDelta = 0;
  let hasSilenceToLoud = false;
  let sumSpeechDensity = 0;
  let count = 0;

  for (let t = start; t <= end; t++) {
    const fv = features.get(t);
    if (!fv) continue;
    count++;
    sumSpeechRate += fv.speechRate;
    if (fv.speechRate > peakSpeechRate) peakSpeechRate = fv.speechRate;
    sumVolumeDelta += fv.volumeDelta;
    if (fv.volumeDelta > peakVolumeDelta) peakVolumeDelta = fv.volumeDelta;
    if (fv.silenceToLoud) hasSilenceToLoud = true;
    sumSpeechDensity += fv.speechDensity;
  }

  if (count === 0) {
    return {
      avgSpeechRate: 0,
      peakSpeechRate: 0,
      avgVolumeDelta: 0,
      peakVolumeDelta: 0,
      hasSilenceToLoud: false,
      avgSpeechDensity: 0,
    };
  }

  return {
    avgSpeechRate: sumSpeechRate / count,
    peakSpeechRate,
    avgVolumeDelta: sumVolumeDelta / count,
    peakVolumeDelta,
    hasSilenceToLoud,
    avgSpeechDensity: sumSpeechDensity / count,
  };
}

/** Format an AudioFeatureSummary as a human-readable string for LLM prompt injection. */
export function formatFeatureSummary(summary: AudioFeatureSummary): string {
  const parts: string[] = [];
  parts.push(`speech rate: avg ${summary.avgSpeechRate.toFixed(1)} w/s, peak ${summary.peakSpeechRate.toFixed(1)} w/s`);
  if (summary.peakVolumeDelta > 0) {
    parts.push(`volume: ${summary.peakVolumeDelta.toFixed(1)}dB above recent average`);
  }
  if (summary.hasSilenceToLoud) {
    parts.push('silence-to-loud transition detected (possible punchline/reveal)');
  }
  if (summary.avgSpeechDensity > 2) {
    parts.push(`high speech density: ${summary.avgSpeechDensity.toFixed(1)} w/s (rapid/overlapping speech)`);
  }
  return `Audio context: ${parts.join(', ')}`;
}
