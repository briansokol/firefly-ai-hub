import { spawn } from 'node:child_process';
import path from 'node:path';
import type { AudioPeak } from './types.js';

export async function extractAndAnalyzeAudio(
  videoPath: string,
  workspacePath: string,
  peakThreshold: number,
): Promise<AudioPeak[]> {
  const audioPath = path.join(workspacePath, 'audio.wav');
  await extractAudioToWav(videoPath, audioPath);
  return detectPeaks(audioPath, peakThreshold);
}

/** Extract audio from video to a 16kHz mono WAV. Exported for use as a standalone activity. */
export function extractAudioToWav(videoPath: string, audioPath: string): Promise<void> {
  console.log(`[audio-analysis] extracting audio from ${videoPath} → ${audioPath}`);
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y', '-i', videoPath,
      '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
      audioPath,
    ]);
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        console.log('[audio-analysis] audio extraction complete');
        resolve();
      } else {
        console.error(`[audio-analysis] ffmpeg extraction failed (code ${code}):\n${stderr.slice(-500)}`);
        reject(new Error(`ffmpeg audio extraction failed with code ${code}`));
      }
    });
  });
}

/** Detect loudness peaks via FFmpeg ebur128. Exported for use as a standalone activity. */
export function detectPeaks(audioPath: string, threshold: number): Promise<AudioPeak[]> {
  console.log(`[audio-analysis] detecting peaks (threshold ${threshold} LUFS)`);
  return new Promise((resolve, reject) => {
    // ebur128 provides momentary loudness (M:) at ~100ms intervals — easy to parse
    const proc = spawn('ffmpeg', [
      '-i', audioPath,
      '-af', 'ebur128=framelog=verbose',
      '-f', 'null', '-',
    ]);

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      // ffmpeg exits 0 for null output; non-zero means real failure
      if (code !== 0 && code !== null && stderr.includes('Error')) {
        console.error(`[audio-analysis] ffmpeg peak detection failed (code ${code}):\n${stderr.slice(-500)}`);
        reject(new Error(`ffmpeg peak detection failed with code ${code}`));
        return;
      }
      const peaks = clusterPeaks(parseEbur128(stderr, threshold));
      console.log(`[audio-analysis] found ${peaks.length} peaks after clustering`);
      resolve(peaks);
    });
  });
}

// Parses ebur128 verbose output lines:
//   [Parsed_ebur128_0 @ 0x...] t: 1.0000    M: -14.2     S: ...
function parseEbur128(output: string, threshold: number): AudioPeak[] {
  const peaks: AudioPeak[] = [];
  const lineRe = /t:\s*(\d+\.?\d*)\s+M:\s*(-?\d+\.?\d*)/;

  for (const line of output.split('\n')) {
    const m = line.match(lineRe);
    if (!m) continue;
    const timestamp = parseFloat(m[1]);
    const rms = parseFloat(m[2]);
    if (!isNaN(rms) && rms > threshold) {
      peaks.push({ timestamp, rms });
    }
  }
  return peaks;
}

// Merge peaks within 5s of each other, keeping the loudest point
function clusterPeaks(peaks: AudioPeak[]): AudioPeak[] {
  if (peaks.length === 0) return [];

  const clustered: AudioPeak[] = [];
  let maxRms = peaks[0].rms;
  let maxTimestamp = peaks[0].timestamp;

  for (let i = 1; i < peaks.length; i++) {
    const gap = peaks[i].timestamp - peaks[i - 1].timestamp;
    if (gap > 5) {
      clustered.push({ timestamp: maxTimestamp, rms: maxRms });
      maxRms = peaks[i].rms;
      maxTimestamp = peaks[i].timestamp;
    } else if (peaks[i].rms > maxRms) {
      maxRms = peaks[i].rms;
      maxTimestamp = peaks[i].timestamp;
    }
  }
  clustered.push({ timestamp: maxTimestamp, rms: maxRms });

  return clustered;
}
