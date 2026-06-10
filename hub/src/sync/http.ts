// Delta-sync HTTP API for the multi-device app clients. Bearer-token auth.
// Routes: POST /devices/register, POST /sync/push, GET /sync/pull,
//         GET /memories/search (wired in F2).
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { SyncStore, PushPayload, MemoryRow } from './store.js';
import { EPOCH, ScopeViolationError } from './store.js';
import { hashToken } from './provision.js';

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
  if (typeof userId !== 'string' || !userId) {
    return { status: 400, body: { error: 'missing userId' } };
  }
  const { provisionDevice } = await import('./provision.js');
  const { deviceId, deviceToken } = await provisionDevice(store, { userId, name: name.trim() });
  return { status: 200, body: { deviceId, userId, deviceToken } };
}

async function handlePush(
  store: SyncStore,
  body: unknown,
  enforceUserId?: string,
): Promise<JsonResponse> {
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'invalid body' } };
  }
  const payload = body as PushPayload;
  await store.push(payload, enforceUserId);
  return { status: 200, body: { ok: true } };
}

type Auth = { kind: 'admin' } | { kind: 'device'; userId: string };

async function resolveAuth(
  req: IncomingMessage,
  store: SyncStore,
  adminToken: string,
): Promise<Auth | null> {
  const tok = bearer(req);
  if (!tok) return null;
  if (tok === adminToken) return { kind: 'admin' };
  const device = await store.resolveDeviceToken(hashToken(tok));
  return device ? { kind: 'device', userId: device.userId } : null;
}

export function createSyncHttpServer(
  store: SyncStore,
  adminToken: string,
  memorySearch?: MemorySearchFn,
): http.Server {
  if (!adminToken) {
    throw new Error('createSyncHttpServer: adminToken is required');
  }

  return http.createServer(async (req, res) => {
    try {
      const auth = await resolveAuth(req, store, adminToken);
      if (!auth) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';

      // user the request is allowed to act as: a device is locked to its own user;
      // the admin token may target any user via ?user=.
      const scopedUser =
        auth.kind === 'device' ? auth.userId : (url.searchParams.get('user') ?? undefined);

      if (method === 'POST' && url.pathname === '/devices/register') {
        if (auth.kind !== 'admin') {
          send(res, 403, { error: 'admin token required' });
          return;
        }
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
        try {
          const result = await handlePush(
            store,
            body,
            auth.kind === 'device' ? auth.userId : undefined,
          );
          send(res, result.status, result.body);
        } catch (err) {
          if (err instanceof ScopeViolationError) {
            send(res, 403, { error: 'scope violation' });
            return;
          }
          throw err;
        }
        return;
      }

      if (method === 'GET' && url.pathname === '/sync/pull') {
        const since = url.searchParams.get('since') || EPOCH;
        const result = await store.pull(since, scopedUser);
        send(res, 200, result);
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
        const kRaw = url.searchParams.get('k');
        const k = kRaw ? Math.max(1, Math.min(50, Number(kRaw) || 0)) : 8;
        const memories = await memorySearch(scopedUser, q, k);
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
