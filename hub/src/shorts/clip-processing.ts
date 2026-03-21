import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ConfirmedCandidate, TranscriptWord, ClipResult } from './types.js';
import type { SubtitleConfig } from '../types.js';
import { generateSubtitleContent, writeSubtitleFile } from './subtitles.js';

export interface ProcessClipOptions {
  videoPath: string;
  workspacePath: string;
  candidate: ConfirmedCandidate;
  candidateIndex: number;
  clipStart: number;
  clipEnd: number;
  transcript: TranscriptWord[];
  subtitleConfig?: SubtitleConfig;
}

/**
 * Compute clip start/end from a candidate timestamp, snapping boundaries
 * to natural speech pauses for cleaner cuts.
 */
export function computeClipBounds(
  timestamp: number,
  windowSize: number,
  minDuration: number,
  maxDuration: number,
  videoDuration: number,
  transcript: TranscriptWord[],
): { start: number; end: number } {
  // Start with centered window
  let start = timestamp - windowSize / 2;
  let end = timestamp + windowSize / 2;

  // Clamp to video bounds
  start = Math.max(0, start);
  end = Math.min(videoDuration, end);

  // Expand if too short
  let duration = end - start;
  if (duration < minDuration) {
    const expand = (minDuration - duration) / 2;
    start = Math.max(0, start - expand);
    end = Math.min(videoDuration, end + expand);
    // If still too short after clamping, expand the other direction
    duration = end - start;
    if (duration < minDuration) {
      if (start === 0) end = Math.min(videoDuration, start + minDuration);
      else start = Math.max(0, end - minDuration);
    }
  }

  // Trim if too long
  duration = end - start;
  if (duration > maxDuration) {
    const trim = (duration - maxDuration) / 2;
    start += trim;
    end -= trim;
  }

  // Snap to transcript pauses (±3s search range at each edge)
  start = snapToSpeechGap(start, transcript, -3, 3);
  end = snapToSpeechGap(end, transcript, -3, 3);

  // Final clamp
  start = Math.max(0, start);
  end = Math.min(videoDuration, end);

  return { start, end };
}

/**
 * Find the nearest speech gap (>300ms silence between words) within a search
 * range around the target time. Returns the target unchanged if no gap found.
 */
function snapToSpeechGap(
  target: number,
  transcript: TranscriptWord[],
  searchBefore: number,
  searchAfter: number,
): number {
  const lo = target + searchBefore;
  const hi = target + searchAfter;

  let bestGap = target;
  let bestDist = Infinity;

  for (let i = 0; i < transcript.length - 1; i++) {
    const gapStart = transcript[i].end;
    const gapEnd = transcript[i + 1].start;
    const gapDuration = gapEnd - gapStart;

    if (gapDuration < 0.3) continue; // not a significant pause

    // Midpoint of the gap is the best cut point
    const mid = (gapStart + gapEnd) / 2;
    if (mid < lo || mid > hi) continue;

    const dist = Math.abs(mid - target);
    if (dist < bestDist) {
      bestDist = dist;
      bestGap = mid;
    }
  }

  return bestGap;
}

async function getVideoDimensions(videoPath: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      videoPath,
    ], (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`ffprobe failed: ${stderr}`));
        return;
      }
      const data = JSON.parse(stdout) as { streams?: { width?: number; height?: number }[] };
      const stream = data.streams?.[0];
      if (!stream?.width || !stream?.height) {
        reject(new Error('Could not determine video dimensions'));
        return;
      }
      resolve({ width: stream.width, height: stream.height });
    });
  });
}

/**
 * Process a single clip: generate subtitles, crop to 9:16, scale to 1080x1920,
 * and burn in subtitles — all in a single FFmpeg pass.
 */
export async function processClip(opts: ProcessClipOptions): Promise<ClipResult> {
  const {
    videoPath, workspacePath, candidate, candidateIndex,
    clipStart, clipEnd, transcript, subtitleConfig,
  } = opts;

  if (!Number.isFinite(clipStart) || !Number.isFinite(clipEnd)) {
    throw new Error(
      `[processClip] clip ${candidateIndex + 1} has invalid bounds: ` +
      `start=${clipStart}, end=${clipEnd}, candidate.timestamp=${candidate.timestamp}`,
    );
  }

  const clipDir = path.join(workspacePath, `clip_${String(candidateIndex + 1).padStart(3, '0')}`);
  fs.mkdirSync(clipDir, { recursive: true });

  // Generate and write subtitles
  const assContent = generateSubtitleContent(transcript, clipStart, clipEnd, subtitleConfig);
  const assPath = path.join(clipDir, 'subtitles.ass');
  writeSubtitleFile(assContent, assPath);

  // Determine if video is already vertical
  const { width, height } = await getVideoDimensions(videoPath);
  const isVertical = width / height <= 9 / 16;

  // Build video filter chain
  // ASS path must be escaped for FFmpeg filter syntax (colons and backslashes)
  const escapedAssPath = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  let vf: string;
  if (isVertical) {
    vf = `scale=1080:1920,ass='${escapedAssPath}'`;
  } else {
    const cropOffset = candidate.cropOffset ?? 0.5;
    // crop width = ih * 9/16, crop height = ih
    // x_offset = cropOffset * (iw - crop_width)
    const xExpr = `${cropOffset}*(iw-ih*9/16)`;
    vf = `crop=ih*9/16:ih:${xExpr}:0,scale=1080:1920,ass='${escapedAssPath}'`;
  }

  const outputPath = path.join(clipDir, 'final.mp4');

  console.log(`[clip-processing] Processing clip ${candidateIndex + 1}: ${clipStart.toFixed(1)}s - ${clipEnd.toFixed(1)}s`);

  await new Promise<void>((resolve, reject) => {
    execFile('ffmpeg', [
      '-ss', String(clipStart),
      '-to', String(clipEnd),
      '-i', videoPath,
      '-vf', vf,
      '-c:v', 'libx264',
      '-crf', '18',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-y',
      outputPath,
    ], { maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        console.error(`[clip-processing] FFmpeg failed for clip ${candidateIndex + 1}: ${stderr.slice(-500)}`);
        reject(new Error(`FFmpeg failed for clip ${candidateIndex + 1}`));
      } else {
        console.log(`[clip-processing] Clip ${candidateIndex + 1} complete → ${outputPath}`);
        resolve();
      }
    });
  });

  return {
    candidateIndex,
    timestamp: candidate.timestamp,
    startTime: clipStart,
    endTime: clipEnd,
    outputPath,
    subtitlePath: assPath,
    duration: clipEnd - clipStart,
  };
}
