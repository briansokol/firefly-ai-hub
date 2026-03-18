import fs from 'node:fs';
import path from 'node:path';
import type OpenAI from 'openai';
import type { AudioPeak, TranscriptWord, Candidate, ClipCategory, AudioFeatureSummary, AudioEvent, ProsodyBucket } from './types.js';
import { computeAudioFeatures, summarizeFeaturesForWindow, formatFeatureSummary } from './audio-features.js';
import type { FeatureVector } from './types.js';

const SEGMENT_WINDOW_BEFORE = 15; // seconds before peak
const SEGMENT_WINDOW_AFTER = 45;  // seconds after peak
const MAX_PEAKS_TO_SCORE = 20;
const MAX_WINDOWS_TO_SCORE = 40;
const VALID_CATEGORIES: ClipCategory[] = ['humor', 'action', 'dramatic', 'story'];

// ── System prompt ────────────────────────────────────────────────────────────

const SCORING_SYSTEM_PROMPT = `You are an expert YouTube Shorts curator. Your job is to identify moments that would make compelling, viral-worthy short-form clips.

Scoring rubric:
  1-3: Mundane, filler, routine gameplay, nothing a viewer would clip
  4-6: Mildly interesting, decent moment but not worth a dedicated Short
  7-8: Compelling — would make someone stop scrolling and watch
  9-10: Viral-worthy — genuinely hilarious, jaw-dropping, or emotionally powerful

Guidelines:
- Quiet gems (wit, storytelling, emotional moments) are just as valuable as loud action
- A funny one-liner scores higher than generic excitement
- Consider: would YOU send this clip to a friend?
- Score relative to typical gaming content, not all of YouTube

Always respond with JSON only, no other text.`;

// ── Prompt builders ─────────────────────────────────────────────────────────

export function buildScoringPrompt(
  startTime: number,
  endTime: number,
  text: string,
  opts?: { videoTitle?: string; audioContext?: string; isPass2?: boolean },
): string {
  const parts: string[] = [];

  if (opts?.videoTitle) {
    parts.push(`This is from a video titled "${opts.videoTitle}".`);
  }

  parts.push(
    `Segment (${Math.round(startTime)}s – ${Math.round(endTime)}s):\n${text}`,
  );

  if (opts?.audioContext) {
    parts.push(opts.audioContext);
  }

  if (opts?.isPass2) {
    parts.push(
      'This is a second-pass evaluation. Score carefully and explain your reasoning in detail.',
    );
  }

  parts.push(
    'Reply with JSON: {"reasoning": "<1-2 sentence explanation>", "score": <1-10>, "quote": "<best 5-8 words>", "category": "<humor|action|dramatic|story>"}',
  );

  return parts.join('\n\n');
}

// Keep backward-compatible exports for tests
export function buildPeakScoringPrompt(timestamp: number, text: string): string {
  return buildScoringPrompt(
    timestamp - SEGMENT_WINDOW_BEFORE,
    timestamp + SEGMENT_WINDOW_AFTER,
    text,
  );
}

export function buildWindowScoringPrompt(startTime: number, endTime: number, text: string): string {
  return buildScoringPrompt(startTime, endTime, text);
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

function parseStructuredResponse(
  content: string,
  timestamp: number,
  fallbackText: string,
): Candidate {
  // Match JSON — may contain nested quotes, so use a greedy match
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { timestamp, quote: fallbackText.slice(0, 50), score: 5 };
  }

  const parsed = JSON.parse(jsonMatch[0]) as {
    score?: number;
    quote?: string;
    reasoning?: string;
    category?: string;
  };

  const score = typeof parsed.score === 'number'
    ? Math.min(10, Math.max(1, parsed.score))
    : 5;
  const quote = typeof parsed.quote === 'string' ? parsed.quote : fallbackText.slice(0, 50);
  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined;
  const category = VALID_CATEGORIES.includes(parsed.category as ClipCategory)
    ? (parsed.category as ClipCategory)
    : undefined;

  return { timestamp, quote, score, reasoning, category };
}

async function scoreSegment(
  timestamp: number,
  words: TranscriptWord[],
  prompt: string,
  client: OpenAI,
  model: string,
  useSystemPrompt = false,
): Promise<Candidate> {
  if (words.length === 0) {
    console.log(`[candidates] no speech near ${timestamp.toFixed(1)}s, using default score`);
    return { timestamp, quote: '(no speech)', score: 3 };
  }

  const text = words.map((w) => w.word).join(' ').trim();

  const messages: OpenAI.ChatCompletionMessageParam[] = useSystemPrompt
    ? [
        { role: 'system' as const, content: SCORING_SYSTEM_PROMPT },
        { role: 'user' as const, content: prompt },
      ]
    : [{ role: 'user' as const, content: prompt }];

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.chat.completions.create({ model, messages });
      const content = response.choices[0]?.message?.content ?? '{}';
      return parseStructuredResponse(content, timestamp, text);
    } catch (e) {
      console.error(`[candidates] Ollama error on attempt ${attempt + 1}: ${e}`);
      if (attempt === 1) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  console.warn(`[candidates] falling back to default score for ${timestamp.toFixed(1)}s`);
  return { timestamp, quote: text.slice(0, 50), score: 5 };
}

async function scoreWindows(
  windows: { timestamp: number; words: TranscriptWord[] }[],
  client: OpenAI,
  model: string,
  opts?: { videoTitle?: string; features?: Map<number, FeatureVector>; useSystemPrompt?: boolean },
): Promise<Candidate[]> {
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
    const windowDuration = win.words.length > 0
      ? win.words[win.words.length - 1].end - win.words[0].start
      : 0;
    const startTime = win.timestamp - windowDuration / 2;
    const endTime = win.timestamp + windowDuration / 2;

    let audioContext: string | undefined;
    if (opts?.features) {
      const summary = summarizeFeaturesForWindow(opts.features, startTime, endTime);
      audioContext = formatFeatureSummary(summary);
    }

    const prompt = buildScoringPrompt(startTime, endTime, text, {
      videoTitle: opts?.videoTitle,
      audioContext,
    });
    console.log(`[candidates] scoring window ${i + 1}/${sampled.length} at ${win.timestamp.toFixed(1)}s`);
    const candidate = await scoreSegment(
      win.timestamp, win.words, prompt, client, model, opts?.useSystemPrompt,
    );
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

// ── Diversity enforcement ───────────────────────────────────────────────────

export function enforceDiversity(candidates: Candidate[]): Candidate[] {
  if (candidates.length <= 2) return candidates;

  const categorized = candidates.filter((c) => c.category);
  if (categorized.length === 0) return candidates;

  // Count categories
  const counts = new Map<ClipCategory, number>();
  for (const c of categorized) {
    counts.set(c.category!, (counts.get(c.category!) ?? 0) + 1);
  }

  // Find the dominant category
  let dominantCategory: ClipCategory | undefined;
  let dominantCount = 0;
  for (const [cat, count] of counts) {
    if (count > dominantCount) {
      dominantCount = count;
      dominantCategory = cat;
    }
  }

  // Only intervene if >60% share a category
  if (!dominantCategory || dominantCount / candidates.length <= 0.6) {
    return candidates;
  }

  console.log(`[candidates] diversity: ${dominantCount}/${candidates.length} clips are "${dominantCategory}", enforcing diversity`);

  // Find the lowest-scoring dominant-category clip
  const result = [...candidates];
  const dominantClips = result
    .map((c, i) => ({ candidate: c, index: i }))
    .filter((x) => x.candidate.category === dominantCategory)
    .sort((a, b) => a.candidate.score - b.candidate.score);

  // Find the highest-scoring clip from an underrepresented category that isn't already selected
  // (look through all deduplicated candidates, not just the final selection)
  const underrepresented = categorized
    .filter((c) => c.category !== dominantCategory && !result.includes(c))
    .sort((a, b) => b.score - a.score);

  if (dominantClips.length > 0 && underrepresented.length > 0) {
    const swapOut = dominantClips[0];
    const swapIn = underrepresented[0];
    console.log(`[candidates] swapping "${swapOut.candidate.quote}" (${dominantCategory}, score ${swapOut.candidate.score}) for "${swapIn.quote}" (${swapIn.category}, score ${swapIn.score})`);
    result[swapOut.index] = swapIn;
  }

  return result;
}

// ── Main entry point ────────────────────────────────────────────────────────

export interface IdentifyCandidatesOpts {
  peaks: AudioPeak[];
  transcript: TranscriptWord[];
  workspacePath: string;
  maxClips: number;
  ollamaClient: OpenAI;
  model: string;
  windowSize?: number;
  windowOverlap?: number;
  videoTitle?: string;
  screeningModel?: string;
}

export async function identifyCandidates(
  peaks: AudioPeak[],
  transcript: TranscriptWord[],
  workspacePath: string,
  maxClips: number,
  ollamaClient: OpenAI,
  model: string,
  windowSize = 30,
  windowOverlap = 15,
  videoTitle?: string,
  screeningModel?: string,
  audioEvents?: AudioEvent[],
  prosody?: ProsodyBucket[],
): Promise<Candidate[]> {
  // Compute derived audio features (Phase 1 + optional Phase 2 signals)
  const features = computeAudioFeatures(peaks, transcript, audioEvents, prosody);
  console.log(`[candidates] computed audio features for ${features.size} seconds`);

  // Determine scoring models for two-pass
  const pass1Model = screeningModel || model;
  const pass2Model = model;
  const isTwoPass = !!screeningModel && screeningModel !== model;

  if (isTwoPass) {
    console.log(`[candidates] two-pass scoring: pass 1 with ${pass1Model}, pass 2 with ${pass2Model}`);
  }

  // ── Pass 1: Screen all segments ──────────────────────────────────────────

  // 1a. Score audio peaks
  const topPeaks = [...peaks]
    .sort((a, b) => b.rms - a.rms)
    .slice(0, MAX_PEAKS_TO_SCORE);

  console.log(`[candidates] pass 1: scoring ${topPeaks.length} peaks with model ${pass1Model}`);
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

    let audioContext: string | undefined;
    const summary = summarizeFeaturesForWindow(
      features,
      peak.timestamp - SEGMENT_WINDOW_BEFORE,
      peak.timestamp + SEGMENT_WINDOW_AFTER,
    );
    audioContext = formatFeatureSummary(summary);

    const prompt = isTwoPass
      // Pass 1 screening uses simpler prompt
      ? buildScoringPrompt(
          peak.timestamp - SEGMENT_WINDOW_BEFORE,
          peak.timestamp + SEGMENT_WINDOW_AFTER,
          text,
        )
      // Single-pass uses full enhanced prompt
      : buildScoringPrompt(
          peak.timestamp - SEGMENT_WINDOW_BEFORE,
          peak.timestamp + SEGMENT_WINDOW_AFTER,
          text,
          { videoTitle, audioContext },
        );

    const candidate = await scoreSegment(
      peak.timestamp, words, prompt, ollamaClient, pass1Model, !isTwoPass,
    );
    console.log(`[candidates] peak ${i + 1} scored ${candidate.score}: "${candidate.quote}"`);
    peakCandidates.push(candidate);
  }

  // 1b. Score sliding windows
  const windows = generateSlidingWindows(transcript, windowSize, windowOverlap);
  const windowCandidates = await scoreWindows(windows, ollamaClient, pass1Model, {
    videoTitle: isTwoPass ? undefined : videoTitle,
    features: isTwoPass ? undefined : features,
    useSystemPrompt: !isTwoPass,
  });

  // 1c. Merge and deduplicate
  const allPass1 = [...peakCandidates, ...windowCandidates];
  const deduplicatedPass1 = deduplicateCandidates(allPass1, windowOverlap);

  // ── Pass 2: Re-score top finalists with full model ───────────────────────

  let finalCandidates: Candidate[];

  if (isTwoPass) {
    const pass2Count = Math.min(deduplicatedPass1.length, maxClips * 2);
    const finalists = deduplicatedPass1.slice(0, pass2Count);
    console.log(`[candidates] pass 2: re-scoring ${finalists.length} finalists with model ${pass2Model}`);

    const pass2Candidates: Candidate[] = [];
    for (let i = 0; i < finalists.length; i++) {
      const finalist = finalists[i];
      // Expand context for pass 2: wider window around the candidate
      const expandedBefore = SEGMENT_WINDOW_BEFORE + 15;
      const expandedAfter = SEGMENT_WINDOW_AFTER + 15;
      const words = getWordsInWindow(
        transcript,
        finalist.timestamp - expandedBefore,
        finalist.timestamp + expandedAfter,
      );
      const text = words.map((w) => w.word).join(' ').trim();

      const summary = summarizeFeaturesForWindow(
        features,
        finalist.timestamp - expandedBefore,
        finalist.timestamp + expandedAfter,
      );
      const audioContext = formatFeatureSummary(summary);

      const prompt = buildScoringPrompt(
        finalist.timestamp - expandedBefore,
        finalist.timestamp + expandedAfter,
        text,
        { videoTitle, audioContext, isPass2: true },
      );

      console.log(`[candidates] pass 2: scoring finalist ${i + 1}/${finalists.length} at ${finalist.timestamp.toFixed(1)}s`);
      const candidate = await scoreSegment(
        finalist.timestamp, words, prompt, ollamaClient, pass2Model, true,
      );
      console.log(`[candidates] pass 2 finalist ${i + 1} scored ${candidate.score} (was ${finalist.score}): "${candidate.quote}"`);
      pass2Candidates.push(candidate);
    }

    // Re-sort by pass 2 scores and take top N
    const sorted = [...pass2Candidates].sort((a, b) => b.score - a.score);
    finalCandidates = sorted.slice(0, maxClips);
  } else {
    finalCandidates = deduplicatedPass1.slice(0, maxClips);
  }

  // ── Diversity enforcement ────────────────────────────────────────────────

  finalCandidates = enforceDiversity(finalCandidates);

  console.log(`[candidates] ${finalCandidates.length} candidates selected (${peakCandidates.length} from peaks, ${windowCandidates.length} from windows, ${allPass1.length - deduplicatedPass1.length} removed by dedup${isTwoPass ? ', two-pass scoring applied' : ''})`);

  fs.writeFileSync(
    path.join(workspacePath, 'candidates.json'),
    JSON.stringify(finalCandidates, null, 2),
  );

  return finalCandidates;
}

function getWordsInWindow(
  transcript: TranscriptWord[],
  start: number,
  end: number,
): TranscriptWord[] {
  return transcript.filter((w) => w.start >= start && w.end <= end);
}
