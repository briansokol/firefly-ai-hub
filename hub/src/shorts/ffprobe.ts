import { execFile } from 'node:child_process';

interface FfprobeFormat {
  duration?: string;
  tags?: { title?: string };
}

interface FfprobeOutput {
  format: FfprobeFormat;
}

export async function getVideoInfo(videoPath: string): Promise<{ title: string; duration: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_format', videoPath],
      (err, stdout) => {
        if (err) { reject(err); return; }
        const data = JSON.parse(stdout) as FfprobeOutput;
        const duration = parseFloat(data.format.duration ?? '0');
        const title = data.format.tags?.title ?? 'Untitled';
        resolve({ title, duration });
      },
    );
  });
}
