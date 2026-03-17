import { describe, it, expect } from 'vitest';
import {
  generateSlidingWindows,
  deduplicateCandidates,
  buildPeakScoringPrompt,
  buildWindowScoringPrompt,
} from '../src/shorts/candidates.js';
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
  it('contains gaming-focused language', () => {
    const prompt = buildPeakScoringPrompt(120, 'some text');
    expect(prompt).toContain('exciting gameplay');
  });

  it('includes the timestamp', () => {
    const prompt = buildPeakScoringPrompt(120, 'some text');
    expect(prompt).toContain('120s');
  });
});

describe('buildWindowScoringPrompt', () => {
  it('does NOT contain gaming-focused language', () => {
    const prompt = buildWindowScoringPrompt(0, 30, 'some text');
    expect(prompt).not.toContain('exciting gameplay');
  });

  it('contains quiet gems language', () => {
    const prompt = buildWindowScoringPrompt(0, 30, 'some text');
    expect(prompt).toContain('quiet gems');
    expect(prompt).toContain('dramatic tension');
  });

  it('includes the time range', () => {
    const prompt = buildWindowScoringPrompt(60, 90, 'some text');
    expect(prompt).toContain('60s');
    expect(prompt).toContain('90s');
  });
});
