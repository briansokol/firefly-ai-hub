#!/usr/bin/env node
// Minimal HTTP server on a Unix socket so the Docker container can trigger
// RGB presets without needing openrgb or USB device access.

import http from 'node:http';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RGB_SET = join(__dirname, 'rgb-set');
const SOCKET = process.env.RGB_SOCKET ?? '/var/run/ai-hub/rgb.sock';

// Remove stale socket from a previous run
try { fs.unlinkSync(SOCKET); } catch { /* ignore */ }

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('POST /<preset>\n');
    return;
  }

  const preset = req.url.slice(1); // "/work" → "work"
  if (!preset) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('missing preset\n');
    return;
  }

  execFile(RGB_SET, [preset], (err, _stdout, stderr) => {
    if (err) {
      console.error(`[rgb-server] preset "${preset}" failed:`, err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(stderr || err.message);
    } else {
      console.log(`[rgb-server] preset "${preset}" applied`);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK\n');
    }
  });
});

server.listen(SOCKET, () => {
  fs.chmodSync(SOCKET, 0o666); // allow the container (any uid) to connect
  console.log(`RGB server listening on ${SOCKET}`);
});

function shutdown() {
  console.log('[rgb-server] shutting down');
  server.close();
  try { fs.unlinkSync(SOCKET); } catch { /* ignore */ }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
