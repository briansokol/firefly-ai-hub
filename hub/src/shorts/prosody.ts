import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProsodyBucket } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROSODY_SCRIPT = path.resolve(__dirname, '../../scripts/prosody.py');

/**
 * Run parselmouth prosody analysis on a WAV file.
 * Returns per-second pitch and energy data.
 */
export async function analyzeProsody(
  audioPath: string,
  workspacePath: string,
): Promise<ProsodyBucket[]> {
  const outputPath = path.join(workspacePath, 'prosody.json');
  console.log(`[prosody] running pitch analysis on ${audioPath}`);

  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [
      PROSODY_SCRIPT,
      '--input', audioPath,
      '--output', outputPath,
    ]);

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`[prosody] ${text}`);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`[prosody] failed (exit ${code})`);
        // Non-fatal — return empty data if prosody analysis fails
        console.warn('[prosody] proceeding without prosody analysis');
        resolve([]);
        return;
      }
      try {
        const raw = fs.readFileSync(outputPath, 'utf8');
        const buckets = JSON.parse(raw) as ProsodyBucket[];
        console.log(`[prosody] analyzed ${buckets.length} time buckets`);
        resolve(buckets);
      } catch (e) {
        console.error(`[prosody] failed to parse output: ${e}`);
        resolve([]);
      }
    });
  });
}
