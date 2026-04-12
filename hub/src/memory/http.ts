import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { MemoryStore } from './store.js';

const VALID_CATEGORIES = new Set(['preference', 'fact', 'project', 'relationship']);

interface JsonResponse {
  status: number;
  body: unknown;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json).toString(),
  });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function handleRecall(
  memoryStore: MemoryStore,
  url: URL,
): JsonResponse {
  const user = url.searchParams.get('user');
  const q = url.searchParams.get('q') ?? '';
  const limitRaw = url.searchParams.get('limit');
  if (!user) return { status: 400, body: { error: 'missing user' } };
  const limit = limitRaw ? Math.max(1, Math.min(50, Number(limitRaw))) : 10;
  const memories = q
    ? memoryStore.searchMemories(user, q, limit)
    : memoryStore.getRecentMemories(user, limit);
  return { status: 200, body: { memories } };
}

function handleRecent(memoryStore: MemoryStore, url: URL): JsonResponse {
  const user = url.searchParams.get('user');
  const limitRaw = url.searchParams.get('limit');
  if (!user) return { status: 400, body: { error: 'missing user' } };
  const limit = limitRaw ? Math.max(1, Math.min(50, Number(limitRaw))) : 5;
  const memories = memoryStore.getRecentMemories(user, limit);
  return { status: 200, body: { memories } };
}

function handleRemember(memoryStore: MemoryStore, body: unknown): JsonResponse {
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'invalid body' } };
  }
  const { user, category, content } = body as Record<string, unknown>;
  if (typeof user !== 'string' || !user) {
    return { status: 400, body: { error: 'missing user' } };
  }
  if (typeof content !== 'string' || !content.trim()) {
    return { status: 400, body: { error: 'missing content' } };
  }
  const cat = typeof category === 'string' && VALID_CATEGORIES.has(category) ? category : 'fact';
  const id = memoryStore.addMemory(user, cat, content.trim());
  return { status: 200, body: { id } };
}

function handleForget(memoryStore: MemoryStore, body: unknown): JsonResponse {
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'invalid body' } };
  }
  const { id } = body as Record<string, unknown>;
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    return { status: 400, body: { error: 'missing id' } };
  }
  memoryStore.deactivateMemory(id);
  return { status: 200, body: { ok: true } };
}

export function createMemoryHttpServer(
  memoryStore: MemoryStore,
  token: string,
): http.Server {
  if (!token) {
    throw new Error('createMemoryHttpServer: token is required');
  }

  return http.createServer(async (req, res) => {
    try {
      if (req.headers['x-auth'] !== token) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/memory/recall') {
        const { status, body } = handleRecall(memoryStore, url);
        send(res, status, body);
        return;
      }

      if (method === 'GET' && url.pathname === '/memory/recent') {
        const { status, body } = handleRecent(memoryStore, url);
        send(res, status, body);
        return;
      }

      if (method === 'POST' && url.pathname === '/memory/remember') {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch {
          send(res, 400, { error: 'invalid json' });
          return;
        }
        const result = handleRemember(memoryStore, body);
        send(res, result.status, result.body);
        return;
      }

      if (method === 'POST' && url.pathname === '/memory/forget') {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch {
          send(res, 400, { error: 'invalid json' });
          return;
        }
        const result = handleForget(memoryStore, body);
        send(res, result.status, result.body);
        return;
      }

      send(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('memory http error:', err);
      send(res, 500, { error: 'internal error' });
    }
  });
}
