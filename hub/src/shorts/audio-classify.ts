import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AudioEvent } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLASSIFY_SCRIPT = path.resolve(__dirname, '../../scripts/audio_classify.py');

/**
 * Run YAMNet audio event classification on a WAV file.
 * Returns timestamped audio events (laughter, cheering, screaming, etc.).
 */
export async function classifyAudioEvents(
  audioPath: string,
  workspacePath: string,
): Promise<AudioEvent[]> {
  const outputPath = path.join(workspacePath, 'audio_events.json');
  console.log(`[audio-classify] running YAMNet classification on ${audioPath}`);

  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [
      CLASSIFY_SCRIPT,
      '--input', audioPath,
      '--output', outputPath,
    ]);

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`[audio-classify] ${text}`);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`[audio-classify] failed (exit ${code})`);
        // Non-fatal — return empty events if classification fails
        console.warn('[audio-classify] proceeding without audio event classification');
        resolve([]);
        return;
      }
      try {
        const raw = fs.readFileSync(outputPath, 'utf8');
        const events = JSON.parse(raw) as AudioEvent[];
        console.log(`[audio-classify] detected ${events.length} audio events`);
        resolve(events);
      } catch (e) {
        console.error(`[audio-classify] failed to parse output: ${e}`);
        resolve([]);
      }
    });
  });
}
