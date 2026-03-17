import fs from 'node:fs';
import path from 'node:path';
import type OpenAI from 'openai';
import type { AudioPeak, TranscriptWord, Candidate } from './types.js';

const SEGMENT_WINDOW_BEFORE = 15; // seconds before peak
const SEGMENT_WINDOW_AFTER = 45;  // seconds after peak
const MAX_PEAKS_TO_SCORE = 20;
const MAX_WINDOWS_TO_SCORE = 40;

// ── Prompt builders ─────────────────────────────────────────────────────────

export function buildPeakScoringPrompt(timestamp: number, text: string): string {
  return (
    `Here is a segment from a gaming video at timestamp ${Math.round(timestamp)}s:\n\n${text}\n\n` +
    'Rate how interesting this moment would be as a YouTube Short (1-10). ' +
    'Consider: exciting gameplay, funny reactions, surprising events, quotable lines. ' +
    'Reply with JSON only: {"score": <1-10>, "quote": "<best 5-8 words from the segment>"}'
  );
}

export function buildWindowScoringPrompt(startTime: number, endTime: number, text: string): string {
  return (
    `Here is a segment from a video (${Math.round(startTime)}s – ${Math.round(endTime)}s):\n\n${text}\n\n` +
    'Rate how compelling this moment would be as a standalone YouTube Short (1-10). ' +
    'Consider: humor, wit, dramatic tension, emotional moments, interesting stories, quotable lines, or surprising revelations. ' +
    'Do NOT favor loud or action-heavy moments — quiet gems are just as valuable. ' +
    'Reply with JSON only: {"score": <1-10>, "quote": "<best 5-8 words from the segment>"}'
  );
}

// ── Sliding windows ─────────────────────────────────────────────────────────

export function generateSlidingWindows(
  transcript: TranscriptWord[],
  windowSize: number,
  windowOverlap: number,
): { timestamp: number; words: TranscriptWord[] }[] {
  if (transcript.length === 0) return [];

  const step = windowSize - windowOverlap;
  const firstStart = transcript[0].start;
  const lastEnd = transcript[transcript.length - 1].end;

  const windows: { timestamp: number; words: TranscriptWord[] }[] = [];
  for (let start = firstStart; start < lastEnd; start += step) {
    const end = start + windowSize;
    const words = getWordsInWindow(transcript, start, end);
    if (words.length === 0) continue;
    const midpoint = start + windowSize / 2;
    windows.push({ timestamp: midpoint, words });
  }

  return windows;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

async function scoreSegment(
  timestamp: number,
  words: TranscriptWord[],
  prompt: string,
  client: OpenAI,
  model: string,
): Promise<Candidate> {
  if (words.length === 0) {
    console.log(`[candidates] no speech near ${timestamp.toFixed(1)}s, using default score`);
    return { timestamp, quote: '(no speech)', score: 3 };
  }

  const text = words.map((w) => w.word).join(' ').trim();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
      });
      const content = response.choices[0]?.message?.content ?? '{}';
      const jsonMatch = content.match(/\{[^}]+\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { score?: number; quote?: string };
        const score = typeof parsed.score === 'number' ? Math.min(10, Math.max(1, parsed.score)) : 5;
        const quote = typeof parsed.quote === 'string' ? parsed.quote : text.slice(0, 50);
        return { timestamp, quote, score };
      }
    } catch (e) {
      console.error(`[candidates] Ollama error on attempt ${attempt + 1}: ${e}`);
      if (attempt === 1) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Fallback if Ollama fails
  const text2 = words.map((w) => w.word).join(' ').trim();
  console.warn(`[candidates] falling back to default score for ${timestamp.toFixed(1)}s`);
  return { timestamp, quote: text2.slice(0, 50), score: 5 };
}

async function scoreWindows(
  windows: { timestamp: number; words: TranscriptWord[] }[],
  client: OpenAI,
  model: string,
): Promise<Candidate[]> {
  // If more windows than cap, take evenly-spaced sample
  let sampled = windows;
  if (windows.length > MAX_WINDOWS_TO_SCORE) {
    sampled = [];
    const step = windows.length / MAX_WINDOWS_TO_SCORE;
    for (let i = 0; i < MAX_WINDOWS_TO_SCORE; i++) {
      sampled.push(windows[Math.floor(i * step)]);
    }
  }

  console.log(`[candidates] scoring ${sampled.length} transcript windows with model ${model}`);
  const scored: Candidate[] = [];
  for (let i = 0; i < sampled.length; i++) {
    const win = sampled[i];
    const text = win.words.map((w) => w.word).join(' ').trim();
    const windowSize = win.words.length > 0
      ? win.words[win.words.length - 1].end - win.words[0].start
      : 0;
    const startTime = win.timestamp - windowSize / 2;
    const endTime = win.timestamp + windowSize / 2;
    const prompt = buildWindowScoringPrompt(startTime, endTime, text);
    console.log(`[candidates] scoring window ${i + 1}/${sampled.length} at ${win.timestamp.toFixed(1)}s`);
    const candidate = await scoreSegment(win.timestamp, win.words, prompt, client, model);
    console.log(`[candidates] window ${i + 1} scored ${candidate.score}: "${candidate.quote}"`);
    scored.push(candidate);
  }

  return scored;
}

// ── Deduplication ───────────────────────────────────────────────────────────

export function deduplicateCandidates(
  candidates: Candidate[],
  minSeparation: number,
): Candidate[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept: Candidate[] = [];

  for (const c of sorted) {
    const tooClose = kept.some(
      (k) => Math.abs(k.timestamp - c.timestamp) < minSeparation,
    );
    if (!tooClose) kept.push(c);
  }

  return kept;
}

// ── Main entry point ────────────────────────────────────────────────────────

export async function identifyCandidates(
  peaks: AudioPeak[],
  transcript: TranscriptWord[],
  workspacePath: string,
  maxClips: number,
  ollamaClient: OpenAI,
  model: string,
  windowSize = 30,
  windowOverlap = 15,
): Promise<Candidate[]> {
  // 1. Score audio peaks (existing flow)
  const topPeaks = [...peaks]
    .sort((a, b) => b.rms - a.rms)
    .slice(0, MAX_PEAKS_TO_SCORE);

  console.log(`[candidates] scoring ${topPeaks.length} peaks with model ${model}`);
  const peakCandidates: Candidate[] = [];
  for (let i = 0; i < topPeaks.length; i++) {
    const peak = topPeaks[i];
    console.log(`[candidates] scoring peak ${i + 1}/${topPeaks.length} at ${peak.timestamp.toFixed(1)}s (rms ${peak.rms.toFixed(1)})`);
    const words = getWordsInWindow(
      transcript,
      peak.timestamp - SEGMENT_WINDOW_BEFORE,
      peak.timestamp + SEGMENT_WINDOW_AFTER,
    );
    const text = words.map((w) => w.word).join(' ').trim();
    const prompt = buildPeakScoringPrompt(peak.timestamp, text);
    const candidate = await scoreSegment(peak.timestamp, words, prompt, ollamaClient, model);
    console.log(`[candidates] peak ${i + 1} scored ${candidate.score}: "${candidate.quote}"`);
    peakCandidates.push(candidate);
  }

  // 2. Generate sliding windows and score them
  const windows = generateSlidingWindows(transcript, windowSize, windowOverlap);
  const windowCandidates = await scoreWindows(windows, ollamaClient, model);

  // 3. Merge and deduplicate
  const allCandidates = [...peakCandidates, ...windowCandidates];
  const deduplicated = deduplicateCandidates(allCandidates, windowOverlap);

  // 4. Take top N
  const candidates = deduplicated.slice(0, maxClips);
  console.log(`[candidates] top ${candidates.length} candidates selected (${peakCandidates.length} from peaks, ${windowCandidates.length} from windows, ${allCandidates.length - deduplicated.length} removed by dedup)`);

  fs.writeFileSync(
    path.join(workspacePath, 'candidates.json'),
    JSON.stringify(candidates, null, 2),
  );

  return candidates;
}

function getWordsInWindow(
  transcript: TranscriptWord[],
  start: number,
  end: number,
): TranscriptWord[] {
  return transcript.filter((w) => w.start >= start && w.end <= end);
}
