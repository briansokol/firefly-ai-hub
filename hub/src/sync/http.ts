// Delta-sync HTTP API for the multi-device app clients. Bearer-token auth.
// Routes: POST /devices/register, POST /sync/push, GET /sync/pull,
//         GET /memories/search (wired in F2).
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { SyncStore, PushPayload, MemoryRow } from './store.js';
import { EPOCH } from './store.js';

/** Semantic memory search: embed `q`, query Qdrant, hydrate rows. Wired in F2. */
export type MemorySearchFn = (
  userId: string | undefined,
  q: string,
  k: number,
) => Promise<MemoryRow[]>;

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

function bearer(req: IncomingMessage): string | null {
  const h = req.headers['authorization'];
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

async function handleRegister(store: SyncStore, body: unknown): Promise<JsonResponse> {
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'invalid body' } };
  }
  const { name, userId } = body as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) {
    return { status: 400, body: { error: 'missing name' } };
  }
  const uid = typeof userId === 'string' && userId ? userId : await store.getDefaultUserId();
  const result = await store.registerDevice(uid, name.trim());
  return { status: 200, body: result };
}

async function handlePush(store: SyncStore, body: unknown): Promise<JsonResponse> {
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'invalid body' } };
  }
  const payload = body as PushPayload;
  await store.push(payload);
  return { status: 200, body: { ok: true } };
}

async function handlePull(store: SyncStore, url: URL): Promise<JsonResponse> {
  const since = url.searchParams.get('since') || EPOCH;
  const user = url.searchParams.get('user') ?? undefined;
  const result = await store.pull(since, user);
  return { status: 200, body: result };
}

export function createSyncHttpServer(
  store: SyncStore,
  token: string,
  memorySearch?: MemorySearchFn,
): http.Server {
  if (!token) {
    throw new Error('createSyncHttpServer: token is required');
  }

  return http.createServer(async (req, res) => {
    try {
      if (bearer(req) !== token) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';

      if (method === 'POST' && url.pathname === '/devices/register') {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch {
          send(res, 400, { error: 'invalid json' });
          return;
        }
        const result = await handleRegister(store, body);
        send(res, result.status, result.body);
        return;
      }

      if (method === 'POST' && url.pathname === '/sync/push') {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch {
          send(res, 400, { error: 'invalid json' });
          return;
        }
        const result = await handlePush(store, body);
        send(res, result.status, result.body);
        return;
      }

      if (method === 'GET' && url.pathname === '/sync/pull') {
        const result = await handlePull(store, url);
        send(res, result.status, result.body);
        return;
      }

      if (method === 'GET' && url.pathname === '/memories/search') {
        if (!memorySearch) {
          send(res, 501, { error: 'memory search not configured' });
          return;
        }
        const q = url.searchParams.get('q');
        if (!q || !q.trim()) {
          send(res, 400, { error: 'missing q' });
          return;
        }
        const user = url.searchParams.get('user') ?? undefined;
        const kRaw = url.searchParams.get('k');
        const k = kRaw ? Math.max(1, Math.min(50, Number(kRaw) || 0)) : 8;
        const memories = await memorySearch(user, q, k);
        send(res, 200, { memories });
        return;
      }

      send(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('sync http error:', err);
      send(res, 500, { error: 'internal error' });
    }
  });
}
