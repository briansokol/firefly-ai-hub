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

describe('formatFeatureSummary', () => {
  it('includes speech rate info', () => {
    const formatted = formatFeatureSummary({
      avgSpeechRate: 2.5,
      peakSpeechRate: 4.0,
      avgVolumeDelta: 0,
      peakVolumeDelta: 0,
      hasSilenceToLoud: false,
      avgSpeechDensity: 1.0,
    });
    expect(formatted).toContain('2.5 w/s');
    expect(formatted).toContain('4.0 w/s');
  });

  it('includes silence-to-loud when detected', () => {
    const formatted = formatFeatureSummary({
      avgSpeechRate: 0,
      peakSpeechRate: 0,
      avgVolumeDelta: 0,
      peakVolumeDelta: 0,
      hasSilenceToLoud: true,
      avgSpeechDensity: 0,
    });
    expect(formatted).toContain('silence-to-loud');
  });
});
