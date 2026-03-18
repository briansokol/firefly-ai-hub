import type {
  AudioPeak, TranscriptWord, FeatureVector, AudioFeatureSummary,
  AudioEvent, ProsodyBucket,
} from './types.js';

const ROLLING_AVG_WINDOW = 10; // seconds for rolling LUFS average
const SILENCE_GAP_THRESHOLD = 1.5; // seconds of silence before a loud moment
const SPEECH_DENSITY_WINDOW = 3; // seconds for measuring rapid speech bursts

/**
 * Compute per-second audio features from peaks, transcript, and optional
 * Phase 2 signals (audio events from YAMNet, prosody from parselmouth).
 */
export function computeAudioFeatures(
  peaks: AudioPeak[],
  transcript: TranscriptWord[],
  audioEvents?: AudioEvent[],
  prosody?: ProsodyBucket[],
): Map<number, FeatureVector> {
  const features = new Map<number, FeatureVector>();
  if (peaks.length === 0 && transcript.length === 0) return features;

  // Determine time range from all sources
  const maxTime = Math.ceil(Math.max(
    peaks.length > 0 ? peaks[peaks.length - 1].timestamp : 0,
    transcript.length > 0 ? transcript[transcript.length - 1].end : 0,
    audioEvents?.length ? audioEvents[audioEvents.length - 1].timestamp : 0,
    prosody?.length ? prosody[prosody.length - 1].timestamp : 0,
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

  // Pre-index audio events by second (keep highest confidence per second)
  const eventBySecond = new Map<number, { confidence: number; event: string }>();
  if (audioEvents) {
    for (const ev of audioEvents) {
      const sec = Math.floor(ev.timestamp);
      const existing = eventBySecond.get(sec);
      if (!existing || ev.confidence > existing.confidence) {
        eventBySecond.set(sec, { confidence: ev.confidence, event: ev.event });
      }
    }
  }

  // Pre-index prosody by second
  const prosodyBySecond = new Map<number, ProsodyBucket>();
  if (prosody) {
    for (const bucket of prosody) {
      prosodyBySecond.set(Math.floor(bucket.timestamp), bucket);
    }
  }

  for (let t = 0; t <= maxTime; t++) {
    const ev = eventBySecond.get(t);
    const pros = prosodyBySecond.get(t);

    features.set(t, {
      speechRate: computeSpeechRate(transcript, t),
      volumeDelta: computeVolumeDelta(peakBySecond, t),
      silenceToLoud: detectSilenceToLoud(transcript, peakBySecond, t),
      speechDensity: computeSpeechDensity(transcript, t),
      laughConfidence: ev?.event === 'laughter' ? ev.confidence : 0,
      reactionType: ev?.event,
      pitchRise: pros?.pitch_rise ?? 0,
      energy: pros?.energy ?? 0,
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
  if (!peakBySecond.has(t)) return false;
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
  let peakLaughConfidence = 0;
  let sumPitchRise = 0;
  let peakPitchRise = 0;
  let sumEnergy = 0;
  let count = 0;

  // Track reaction types for dominant reaction
  const reactionCounts = new Map<string, number>();

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
    if (fv.laughConfidence > peakLaughConfidence) peakLaughConfidence = fv.laughConfidence;
    sumPitchRise += fv.pitchRise;
    if (fv.pitchRise > peakPitchRise) peakPitchRise = fv.pitchRise;
    sumEnergy += fv.energy;
    if (fv.reactionType) {
      reactionCounts.set(fv.reactionType, (reactionCounts.get(fv.reactionType) ?? 0) + 1);
    }
  }

  if (count === 0) {
    return {
      avgSpeechRate: 0,
      peakSpeechRate: 0,
      avgVolumeDelta: 0,
      peakVolumeDelta: 0,
      hasSilenceToLoud: false,
      avgSpeechDensity: 0,
      peakLaughConfidence: 0,
      avgPitchRise: 0,
      peakPitchRise: 0,
      avgEnergy: 0,
    };
  }

  // Find dominant reaction type
  let dominantReaction: string | undefined;
  let maxReactionCount = 0;
  for (const [reaction, cnt] of reactionCounts) {
    if (cnt > maxReactionCount) {
      maxReactionCount = cnt;
      dominantReaction = reaction;
    }
  }

  return {
    avgSpeechRate: sumSpeechRate / count,
    peakSpeechRate,
    avgVolumeDelta: sumVolumeDelta / count,
    peakVolumeDelta,
    hasSilenceToLoud,
    avgSpeechDensity: sumSpeechDensity / count,
    peakLaughConfidence,
    dominantReaction,
    avgPitchRise: sumPitchRise / count,
    peakPitchRise,
    avgEnergy: sumEnergy / count,
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
  if (summary.peakLaughConfidence > 0) {
    parts.push(`laughter detected (confidence: ${summary.peakLaughConfidence.toFixed(2)})`);
  }
  if (summary.dominantReaction && summary.dominantReaction !== 'laughter') {
    parts.push(`${summary.dominantReaction} detected`);
  }
  if (summary.peakPitchRise > 50) {
    parts.push(`vocal excitement: pitch ${summary.peakPitchRise.toFixed(0)}Hz above baseline`);
  }
  if (summary.avgEnergy > 1.3) {
    parts.push(`high vocal energy: ${summary.avgEnergy.toFixed(1)}x average`);
  }
  return `Audio context: ${parts.join(', ')}`;
}
