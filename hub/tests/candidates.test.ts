import { describe, it, expect } from 'vitest';
import {
  generateSlidingWindows,
  deduplicateCandidates,
  buildPeakScoringPrompt,
  buildWindowScoringPrompt,
  buildScoringPrompt,
  enforceDiversity,
} from '../src/shorts/candidates.js';
import {
  computeAudioFeatures,
  summarizeFeaturesForWindow,
  formatFeatureSummary,
} from '../src/shorts/audio-features.js';
import type { TranscriptWord, Candidate } from '../src/shorts/types.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function word(w: string, start: number, end: number): TranscriptWord {
  return { word: w, start, end };
}

function candidate(timestamp: number, score: number): Candidate {
  return { timestamp, quote: 'q', score };
}

// ── generateSlidingWindows ──────────────────────────────────────────────────

describe('generateSlidingWindows', () => {
  it('returns [] for empty transcript', () => {
    expect(generateSlidingWindows([], 30, 15)).toEqual([]);
  });

  it('produces correct number of windows for known duration', () => {
    // 0–90s with 30s window and 15s step → 6 window starts (0,15,30,45,60,75)
    // but window 15–45 has no words (word 'a' ends at 1, 'b' starts at 45) → 5 kept
    const transcript = [word('a', 0, 1), word('b', 45, 46), word('c', 89, 90)];
    const windows = generateSlidingWindows(transcript, 30, 15);
    expect(windows.length).toBe(5);
  });

  it('skips empty windows (no speech in range)', () => {
    // Speech only at 0–1s and 80–81s, gap in middle
    const transcript = [word('start', 0, 1), word('end', 80, 81)];
    const windows = generateSlidingWindows(transcript, 30, 15);
    // Only windows that overlap with speech should be kept
    for (const w of windows) {
      expect(w.words.length).toBeGreaterThan(0);
    }
  });

  it('timestamp is midpoint of window', () => {
    const transcript = [word('a', 0, 1), word('b', 50, 51)];
    const windows = generateSlidingWindows(transcript, 30, 15);
    // First window starts at 0, midpoint = 0 + 30/2 = 15
    expect(windows[0].timestamp).toBe(15);
  });
});

// ── deduplicateCandidates ───────────────────────────────────────────────────

describe('deduplicateCandidates', () => {
  it('returns [] for empty input', () => {
    expect(deduplicateCandidates([], 15)).toEqual([]);
  });

  it('keeps both candidates when far apart', () => {
    const result = deduplicateCandidates(
      [candidate(10, 8), candidate(100, 7)],
      15,
    );
    expect(result).toHaveLength(2);
  });

  it('keeps higher score when candidates are close', () => {
    const result = deduplicateCandidates(
      [candidate(10, 6), candidate(20, 9)],
      15,
    );
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(9);
  });

  it('keeps both at exact boundary (>= minSeparation)', () => {
    const result = deduplicateCandidates(
      [candidate(0, 8), candidate(15, 7)],
      15,
    );
    expect(result).toHaveLength(2);
  });
});

// ── prompt builders ─────────────────────────────────────────────────────────

describe('buildPeakScoringPrompt', () => {
  it('includes the time range derived from peak timestamp', () => {
    const prompt = buildPeakScoringPrompt(120, 'some text');
    expect(prompt).toContain('105s');
    expect(prompt).toContain('165s');
  });

  it('requests structured JSON with reasoning and category', () => {
    const prompt = buildPeakScoringPrompt(120, 'some text');
    expect(prompt).toContain('"reasoning"');
    expect(prompt).toContain('"category"');
  });
});

describe('buildWindowScoringPrompt', () => {
  it('requests structured JSON with reasoning and category', () => {
    const prompt = buildWindowScoringPrompt(0, 30, 'some text');
    expect(prompt).toContain('"reasoning"');
    expect(prompt).toContain('"category"');
    expect(prompt).toContain('humor|action|dramatic|story');
  });

  it('includes the time range', () => {
    const prompt = buildWindowScoringPrompt(60, 90, 'some text');
    expect(prompt).toContain('60s');
    expect(prompt).toContain('90s');
  });
});

// ── buildScoringPrompt (unified) ────────────────────────────────────────────

describe('buildScoringPrompt', () => {
  it('includes video title when provided', () => {
    const prompt = buildScoringPrompt(0, 30, 'text', { videoTitle: 'My Epic Video' });
    expect(prompt).toContain('My Epic Video');
  });

  it('includes audio context when provided', () => {
    const prompt = buildScoringPrompt(0, 30, 'text', {
      audioContext: 'Audio context: speech rate 4.2 w/s',
    });
    expect(prompt).toContain('speech rate 4.2 w/s');
  });

  it('includes pass 2 instructions when isPass2 is true', () => {
    const prompt = buildScoringPrompt(0, 30, 'text', { isPass2: true });
    expect(prompt).toContain('second-pass evaluation');
  });

  it('works with no options', () => {
    const prompt = buildScoringPrompt(0, 30, 'hello world');
    expect(prompt).toContain('hello world');
    expect(prompt).toContain('"reasoning"');
  });
});

// ── enforceDiversity ────────────────────────────────────────────────────────

describe('enforceDiversity', () => {
  it('returns unchanged when candidates have no category', () => {
    const input = [candidate(10, 8), candidate(50, 7), candidate(100, 6)];
    expect(enforceDiversity(input)).toEqual(input);
  });

  it('returns unchanged when <=2 candidates', () => {
    const input = [
      { timestamp: 10, quote: 'q', score: 8, category: 'humor' as const },
      { timestamp: 50, quote: 'q', score: 7, category: 'humor' as const },
    ];
    expect(enforceDiversity(input)).toEqual(input);
  });

  it('returns unchanged when categories are already diverse', () => {
    const input = [
      { timestamp: 10, quote: 'q', score: 8, category: 'humor' as const },
      { timestamp: 50, quote: 'q', score: 7, category: 'action' as const },
      { timestamp: 100, quote: 'q', score: 6, category: 'dramatic' as const },
    ];
    expect(enforceDiversity(input)).toEqual(input);
  });

  it('does not modify when dominant is exactly 60%', () => {
    const input = [
      { timestamp: 10, quote: 'q', score: 9, category: 'humor' as const },
      { timestamp: 50, quote: 'q', score: 8, category: 'humor' as const },
      { timestamp: 100, quote: 'q', score: 7, category: 'humor' as const },
      { timestamp: 200, quote: 'q', score: 6, category: 'action' as const },
      { timestamp: 300, quote: 'q', score: 5, category: 'dramatic' as const },
    ];
    // 3/5 = 60%, threshold is >60%, so no swap
    expect(enforceDiversity(input)).toEqual(input);
  });
});

// ── audio features ──────────────────────────────────────────────────────────

describe('computeAudioFeatures', () => {
  it('returns empty map for no data', () => {
    const features = computeAudioFeatures([], []);
    expect(features.size).toBe(0);
  });

  it('computes speech rate from transcript timestamps', () => {
    const transcript = [
      word('hello', 0, 0.5),
      word('world', 0.6, 1.0),
      word('foo', 0.7, 0.9),
      word('bar', 2, 2.5),
    ];
    const features = computeAudioFeatures([], transcript);
    // At t=0, words starting in [0, 1): hello, world, foo = 3 words/sec
    expect(features.get(0)?.speechRate).toBe(3);
    // At t=2, words starting in [2, 3): bar = 1 word/sec
    expect(features.get(2)?.speechRate).toBe(1);
  });

  it('computes volume delta relative to rolling average', () => {
    const peaks = [
      { timestamp: 0, rms: -20 },
      { timestamp: 5, rms: -20 },
      { timestamp: 10, rms: -10 }, // 10 dB above average of -20
    ];
    const features = computeAudioFeatures(peaks, []);
    const delta = features.get(10)?.volumeDelta ?? 0;
    expect(delta).toBe(10); // -10 - (-20) = 10
  });
});

describe('summarizeFeaturesForWindow', () => {
  it('returns zeroed summary for empty window', () => {
    const features = computeAudioFeatures([], []);
    const summary = summarizeFeaturesForWindow(features, 0, 30);
    expect(summary.avgSpeechRate).toBe(0);
    expect(summary.hasSilenceToLoud).toBe(false);
  });
});

const baseSummary = {
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

describe('formatFeatureSummary', () => {
  it('includes speech rate info', () => {
    const formatted = formatFeatureSummary({
      ...baseSummary,
      avgSpeechRate: 2.5,
      peakSpeechRate: 4.0,
      avgSpeechDensity: 1.0,
    });
    expect(formatted).toContain('2.5 w/s');
    expect(formatted).toContain('4.0 w/s');
  });

  it('includes silence-to-loud when detected', () => {
    const formatted = formatFeatureSummary({
      ...baseSummary,
      hasSilenceToLoud: true,
    });
    expect(formatted).toContain('silence-to-loud');
  });

  it('includes laughter detection info', () => {
    const formatted = formatFeatureSummary({
      ...baseSummary,
      peakLaughConfidence: 0.85,
    });
    expect(formatted).toContain('laughter detected');
    expect(formatted).toContain('0.85');
  });

  it('includes pitch excitement info', () => {
    const formatted = formatFeatureSummary({
      ...baseSummary,
      peakPitchRise: 120,
    });
    expect(formatted).toContain('vocal excitement');
    expect(formatted).toContain('120Hz');
  });

  it('includes high energy info', () => {
    const formatted = formatFeatureSummary({
      ...baseSummary,
      avgEnergy: 1.5,
    });
    expect(formatted).toContain('high vocal energy');
    expect(formatted).toContain('1.5x');
  });
});

// ── Phase 2: audio events + prosody integration ─────────────────────────────

describe('computeAudioFeatures with Phase 2 signals', () => {
  it('integrates audio events into feature vectors', () => {
    const audioEvents = [
      { timestamp: 5, event: 'laughter', class: 'Laughter', confidence: 0.82 },
      { timestamp: 10, event: 'cheering', class: 'Cheering', confidence: 0.65 },
    ];
    const features = computeAudioFeatures(
      [{ timestamp: 5, rms: -10 }],
      [],
      audioEvents,
    );
    expect(features.get(5)?.laughConfidence).toBe(0.82);
    expect(features.get(5)?.reactionType).toBe('laughter');
    expect(features.get(10)?.reactionType).toBe('cheering');
    expect(features.get(10)?.laughConfidence).toBe(0); // cheering, not laughter
  });

  it('integrates prosody data into feature vectors', () => {
    const prosody = [
      { timestamp: 0, mean_pitch: 150, pitch_variance: 20, pitch_rise: 80, energy: 1.2 },
      { timestamp: 1, mean_pitch: 200, pitch_variance: 50, pitch_rise: 130, energy: 1.8 },
    ];
    const features = computeAudioFeatures(
      [{ timestamp: 0, rms: -15 }],
      [],
      [],
      prosody,
    );
    expect(features.get(0)?.pitchRise).toBe(80);
    expect(features.get(0)?.energy).toBe(1.2);
    expect(features.get(1)?.pitchRise).toBe(130);
    expect(features.get(1)?.energy).toBe(1.8);
  });

  it('defaults Phase 2 fields to zero when not provided', () => {
    const features = computeAudioFeatures(
      [{ timestamp: 0, rms: -15 }],
      [word('hi', 0, 0.5)],
    );
    expect(features.get(0)?.laughConfidence).toBe(0);
    expect(features.get(0)?.pitchRise).toBe(0);
    expect(features.get(0)?.energy).toBe(0);
    expect(features.get(0)?.reactionType).toBeUndefined();
  });

  it('summarizes Phase 2 signals across a window', () => {
    const audioEvents = [
      { timestamp: 2, event: 'laughter', class: 'Laughter', confidence: 0.9 },
      { timestamp: 4, event: 'laughter', class: 'Giggle', confidence: 0.6 },
    ];
    const prosody = [
      { timestamp: 2, mean_pitch: 200, pitch_variance: 30, pitch_rise: 100, energy: 1.5 },
      { timestamp: 4, mean_pitch: 180, pitch_variance: 20, pitch_rise: 60, energy: 1.1 },
    ];
    const features = computeAudioFeatures(
      [{ timestamp: 2, rms: -10 }, { timestamp: 4, rms: -12 }],
      [],
      audioEvents,
      prosody,
    );
    const summary = summarizeFeaturesForWindow(features, 0, 5);
    expect(summary.peakLaughConfidence).toBe(0.9);
    expect(summary.dominantReaction).toBe('laughter');
    expect(summary.peakPitchRise).toBe(100);
    expect(summary.avgEnergy).toBeGreaterThan(0);
  });
});
