import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TranscriptWord } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Compiled output lives at dist/shorts/ — two levels up reaches the app root (/app)
const TRANSCRIBE_SCRIPT = path.resolve(__dirname, '../../scripts/transcribe.py');

export async function transcribeAudio(
  videoPath: string,
  workspacePath: string,
  model: string,
  language: string,
): Promise<TranscriptWord[]> {
  const transcriptPath = path.join(workspacePath, 'transcript.json');
  console.log(`[transcription] starting faster-whisper: model=${model} language=${language}`);
  console.log(`[transcription] script path: ${TRANSCRIBE_SCRIPT}`);

  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [
      TRANSCRIBE_SCRIPT,
      '--input', videoPath,
      '--model', model,
      '--language', language,
      '--output', transcriptPath,
    ]);

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      // Stream whisper progress lines to docker logs in real time
      process.stderr.write(`[transcription] ${text}`);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`[transcription] failed (exit ${code})`);
        reject(new Error(`Transcription failed (exit ${code}): ${stderr.slice(-500)}`));
        return;
      }
      console.log('[transcription] complete, reading transcript');
      try {
        const raw = fs.readFileSync(transcriptPath, 'utf8');
        const words = JSON.parse(raw) as TranscriptWord[];
        console.log(`[transcription] parsed ${words.length} words`);
        resolve(words);
      } catch (e) {
        reject(new Error(`Failed to parse transcript JSON: ${e}`));
      }
    });
  });
}
