import fs from 'node:fs';
import path from 'node:path';

const FILES_TO_DELETE = ['source.mp4', 'audio.wav'];

export async function cleanupWorkspace(workspacePath: string): Promise<void> {
  for (const filename of FILES_TO_DELETE) {
    const filePath = path.join(workspacePath, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}
