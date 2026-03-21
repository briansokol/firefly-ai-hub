import fs from 'node:fs';
import path from 'node:path';

// Only delete intermediates — keep source video, clips, and checkpoint on NAS
const FILES_TO_DELETE = ['audio.wav'];

// Temp files created by hosted scoring (Gemini clip uploads, Claude keyframes)
const TEMP_PATTERNS = [/^clip-\d+\.mp4$/, /^keyframe-\d+\.jpg$/];

export async function cleanupWorkspace(workspacePath: string): Promise<void> {
  // Delete known intermediate files
  for (const filename of FILES_TO_DELETE) {
    const filePath = path.join(workspacePath, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[cleanup] Deleted ${filePath}`);
    }
  }

  // Delete temp files matching patterns (in workspace root only, not in clip_*/ dirs)
  try {
    const entries = fs.readdirSync(workspacePath);
    for (const entry of entries) {
      if (TEMP_PATTERNS.some(p => p.test(entry))) {
        const filePath = path.join(workspacePath, entry);
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          fs.unlinkSync(filePath);
          console.log(`[cleanup] Deleted temp file ${filePath}`);
        }
      }
    }
  } catch (err) {
    console.error(`[cleanup] Error cleaning temp files: ${err}`);
  }
}
