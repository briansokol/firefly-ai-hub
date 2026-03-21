import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  Candidate, ConfirmedCandidate, TranscriptWord, ActionPosition,
  AudioPeak, AudioEvent, ProsodyBucket, FeatureVector,
} from './types.js';
import { computeAudioFeatures, summarizeFeaturesForWindow, formatFeatureSummary } from './audio-features.js';
import type { HostedScoringConfig } from '../types.js';

export interface HostedScoringOptions {
  candidates: Candidate[];
  transcript: TranscriptWord[];
  videoPath: string;
  workspacePath: string;
  videoTitle: string;
  peaks: AudioPeak[];
  audioEvents?: AudioEvent[];
  prosody?: ProsodyBucket[];
  config: HostedScoringConfig;
  apiKey: string;
}

interface GeminiScoringResponse {
  score: number;
  reasoning: string;
  confirmed: boolean;
  actionPosition: ActionPosition;
  facecamPosition: string | null;
  cropOffset: number;
}

const VALID_ACTION_POSITIONS: ActionPosition[] = ['left', 'center-left', 'center', 'center-right', 'right'];

const CLIP_PADDING = 60; // seconds of context before/after candidate

/**
 * Dispatch to the right provider based on config.
 */
export async function confirmCandidatesWithHostedAI(
  opts: HostedScoringOptions,
): Promise<ConfirmedCandidate[]> {
  const { config } = opts;

  const candidates = config.max_candidates
    ? opts.candidates.slice(0, config.max_candidates)
    : opts.candidates;

  const optsWithCapped = { ...opts, candidates };

  switch (config.provider) {
    case 'google':
      return scoreWithGemini(optsWithCapped);
    case 'anthropic':
      return scoreWithClaude(optsWithCapped);
    default:
      throw new Error(`Unknown hosted scoring provider: ${config.provider}`);
  }
}

// ── Gemini implementation ─────────────────────────────────────────────────────

async function scoreWithGemini(opts: HostedScoringOptions): Promise<ConfirmedCandidate[]> {
  const { GoogleGenAI } = await import('@google/genai');

  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const confirmClips = opts.config.confirm_clips !== false; // default true
  const results: ConfirmedCandidate[] = [];

  // Pre-compute audio features for transcript context
  const features = computeAudioFeatures(opts.peaks, opts.transcript, opts.audioEvents, opts.prosody);

  for (const candidate of opts.candidates) {
    try {
      const result = confirmClips
        ? await scoreGeminiWithVideo(ai, opts, candidate, features)
        : await scoreGeminiTextOnly(ai, opts, candidate, features);
      results.push(result);
    } catch (err) {
      console.error(`[hosted-scoring] Gemini failed for candidate at ${candidate.timestamp}s: ${err}`);
      // Don't lose candidates due to API errors — keep with local score
      results.push({
        ...candidate,
        confirmed: true,
        actionPosition: 'center',
        cropOffset: 0.5,
      });
    }
  }

  return results;
}

async function scoreGeminiWithVideo(
  ai: any, // GoogleGenAI instance (dynamically imported)
  opts: HostedScoringOptions,
  candidate: Candidate,
  features: Map<number, FeatureVector>,
): Promise<ConfirmedCandidate> {
  const clipPath = await extractClip(opts.videoPath, opts.workspacePath, candidate.timestamp);

  try {
    // Upload to Gemini Files API
    console.log(`[hosted-scoring] Uploading clip for candidate at ${candidate.timestamp}s`);
    const uploadedFile = await ai.files.upload({
      file: clipPath,
      config: { mimeType: 'video/mp4' },
    });

    // Poll until processing is complete
    let file = uploadedFile;
    while (file.state === 'PROCESSING') {
      await sleep(2000);
      file = await ai.files.get({ name: file.name! });
    }

    if (file.state === 'FAILED') {
      throw new Error(`Gemini file processing failed for ${file.name}`);
    }

    const prompt = buildGeminiPrompt(candidate, opts, features);

    const response = await ai.models.generateContent({
      model: opts.config.model,
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: file.uri!, mimeType: 'video/mp4' } },
            { text: prompt },
          ],
        },
      ],
    });

    const parsed = parseGeminiResponse(response.text ?? '');

    // Clean up uploaded file (best-effort)
    ai.files.delete({ name: file.name! }).catch(() => {});

    return {
      ...candidate,
      hostedScore: parsed.score,
      hostedReasoning: parsed.reasoning,
      confirmed: parsed.confirmed,
      actionPosition: parsed.actionPosition,
      facecamPosition: parsed.facecamPosition,
      cropOffset: parsed.cropOffset,
    };
  } finally {
    // Clean up local clip
    fs.promises.unlink(clipPath).catch(() => {});
  }
}

async function scoreGeminiTextOnly(
  ai: any, // GoogleGenAI instance (dynamically imported)
  opts: HostedScoringOptions,
  candidate: Candidate,
  features: Map<number, FeatureVector>,
): Promise<ConfirmedCandidate> {
  const prompt = buildGeminiPrompt(candidate, opts, features);

  const response = await ai.models.generateContent({
    model: opts.config.model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });

  const parsed = parseGeminiResponse(response.text ?? '');

  return {
    ...candidate,
    hostedScore: parsed.score,
    hostedReasoning: parsed.reasoning,
    confirmed: parsed.confirmed,
    actionPosition: parsed.actionPosition,
    facecamPosition: parsed.facecamPosition,
    cropOffset: parsed.cropOffset,
  };
}

function buildGeminiPrompt(
  candidate: Candidate,
  opts: HostedScoringOptions,
  features: Map<number, FeatureVector>,
): string {
  // Get transcript text around candidate
  const windowStart = Math.max(0, candidate.timestamp - CLIP_PADDING);
  const windowEnd = candidate.timestamp + CLIP_PADDING;
  const transcriptText = opts.transcript
    .filter(w => w.start >= windowStart && w.end <= windowEnd)
    .map(w => w.word)
    .join(' ');

  // Get audio feature summary
  const featureSummary = summarizeFeaturesForWindow(features, windowStart, windowEnd);
  const audioContext = formatFeatureSummary(featureSummary);

  return `This is a gaming video clip. A local AI model identified this as a potentially exciting/funny moment.

Local model's assessment: Score ${candidate.score}/10 — "${candidate.reasoning ?? 'no reasoning provided'}"

Transcript of this segment:
${transcriptText}

${audioContext}

Please analyze this clip and respond with JSON only:
{
  "score": <1-10, how compelling as a YouTube Short>,
  "reasoning": "<1-2 sentence explanation>",
  "confirmed": <true if worth making into a Short, false otherwise>,
  "actionPosition": "<left|center-left|center|center-right|right>",
  "facecamPosition": "<position description or null if no facecam>",
  "cropOffset": <0.0-1.0, suggested horizontal crop center for 9:16 vertical framing>
}`;
}

function parseGeminiResponse(text: string): GeminiScoringResponse {
  // Strip markdown code fences if present
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;

  const score = typeof parsed.score === 'number' ? Math.max(1, Math.min(10, parsed.score)) : 5;
  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';
  const confirmed = typeof parsed.confirmed === 'boolean' ? parsed.confirmed : score >= 7;
  const actionPosition = VALID_ACTION_POSITIONS.includes(parsed.actionPosition as ActionPosition)
    ? (parsed.actionPosition as ActionPosition)
    : 'center';
  const facecamPosition = typeof parsed.facecamPosition === 'string' ? parsed.facecamPosition : null;
  const cropOffset = typeof parsed.cropOffset === 'number'
    ? Math.max(0, Math.min(1, parsed.cropOffset))
    : 0.5;

  return { score, reasoning, confirmed, actionPosition, facecamPosition, cropOffset };
}

// ── Claude alternative ────────────────────────────────────────────────────────

async function scoreWithClaude(opts: HostedScoringOptions): Promise<ConfirmedCandidate[]> {
  // @ts-expect-error — @anthropic-ai/sdk is an optional dependency, installed only when provider is 'anthropic'
  const { default: Anthropic } = await import('@anthropic-ai/sdk');

  const client = new Anthropic({ apiKey: opts.apiKey });
  const features = computeAudioFeatures(opts.peaks, opts.transcript, opts.audioEvents, opts.prosody);
  const results: ConfirmedCandidate[] = [];

  for (const candidate of opts.candidates) {
    try {
      const result = await scoreClaudeCandidate(client, opts, candidate, features);
      results.push(result);
    } catch (err) {
      console.error(`[hosted-scoring] Claude failed for candidate at ${candidate.timestamp}s: ${err}`);
      results.push({
        ...candidate,
        confirmed: true,
        actionPosition: 'center',
        cropOffset: 0.5,
      });
    }
  }

  return results;
}

async function scoreClaudeCandidate(
  client: any, // Anthropic instance (dynamically imported)
  opts: HostedScoringOptions,
  candidate: Candidate,
  features: Map<number, FeatureVector>,
): Promise<ConfirmedCandidate> {
  // Extract a keyframe at the candidate timestamp
  const keyframePath = path.join(
    opts.workspacePath,
    `keyframe-${Math.round(candidate.timestamp)}.jpg`,
  );
  await extractKeyframe(opts.videoPath, candidate.timestamp, keyframePath);

  try {
    const imageData = fs.readFileSync(keyframePath).toString('base64');

    const windowStart = Math.max(0, candidate.timestamp - CLIP_PADDING);
    const windowEnd = candidate.timestamp + CLIP_PADDING;
    const transcriptText = opts.transcript
      .filter(w => w.start >= windowStart && w.end <= windowEnd)
      .map(w => w.word)
      .join(' ');

    const featureSummary = summarizeFeaturesForWindow(features, windowStart, windowEnd);
    const audioContext = formatFeatureSummary(featureSummary);

    const prompt = `This is a gaming video. A local AI model identified this as a potentially exciting/funny moment. Here is a keyframe from the moment.

Local model's assessment: Score ${candidate.score}/10 — "${candidate.reasoning ?? 'no reasoning provided'}"

Transcript of this segment:
${transcriptText}

${audioContext}

Please analyze this moment and respond with JSON only:
{
  "score": <1-10, how compelling as a YouTube Short>,
  "reasoning": "<1-2 sentence explanation>",
  "confirmed": <true if worth making into a Short, false otherwise>,
  "actionPosition": "<left|center-left|center|center-right|right>",
  "facecamPosition": "<position description or null if no facecam>",
  "cropOffset": <0.0-1.0, suggested horizontal crop center for 9:16 vertical framing>
}`;

    const response = await client.messages.create({
      model: opts.config.model,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: imageData },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
    });

    const textBlock = response.content.find((b: any) => b.type === 'text');
    const parsed = parseGeminiResponse(textBlock?.text ?? '');

    return {
      ...candidate,
      hostedScore: parsed.score,
      hostedReasoning: parsed.reasoning,
      confirmed: parsed.confirmed,
      actionPosition: parsed.actionPosition,
      facecamPosition: parsed.facecamPosition,
      cropOffset: parsed.cropOffset,
    };
  } finally {
    fs.promises.unlink(keyframePath).catch(() => {});
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function extractClip(
  videoPath: string,
  workspacePath: string,
  timestamp: number,
): Promise<string> {
  const start = Math.max(0, timestamp - CLIP_PADDING);
  const end = timestamp + CLIP_PADDING;
  const clipPath = path.join(workspacePath, `clip-${Math.round(timestamp)}.mp4`);

  await new Promise<void>((resolve, reject) => {
    execFile('ffmpeg', [
      '-ss', String(start),
      '-to', String(end),
      '-i', videoPath,
      '-c', 'copy',
      '-y',
      clipPath,
    ], (err, _stdout, stderr) => {
      if (err) {
        console.error(`[hosted-scoring] ffmpeg clip extraction failed: ${stderr}`);
        reject(err);
      } else {
        resolve();
      }
    });
  });

  return clipPath;
}

async function extractKeyframe(
  videoPath: string,
  timestamp: number,
  outputPath: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('ffmpeg', [
      '-ss', String(timestamp),
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', '2',
      '-y',
      outputPath,
    ], (err, _stdout, stderr) => {
      if (err) {
        console.error(`[hosted-scoring] ffmpeg keyframe extraction failed: ${stderr}`);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
