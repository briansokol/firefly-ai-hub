import http from 'node:http';

const RGB_SOCKET = process.env.RGB_SOCKET ?? '/var/run/ai-hub/rgb.sock';

/** Send a preset to the host-side RGB server over a Unix socket. */
export function setRgb(preset: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: RGB_SOCKET, path: `/${preset}`, method: 'POST' },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode === 200) resolve();
          else reject(new Error(`RGB server error (${res.statusCode}): ${body.trim()}`));
        });
      },
    );
    req.on('error', (err) => reject(err));
    req.end();
  });
}
