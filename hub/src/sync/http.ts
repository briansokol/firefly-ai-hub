// Delta-sync HTTP API for the multi-device app clients. Bearer-token auth.
// Routes: POST /devices/register, POST /sync/push, GET /sync/pull,
//         GET /memories/search (wired in F2).
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { SyncStore, PushPayload, MemoryRow } from './store.js';
import { EPOCH, ScopeViolationError } from './store.js';
import { hashToken, provisionUser, provisionDevice } from './provision.js';
import { PROFILE_MODELS, type LitellmConfig } from './litellm.js';

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

async function handleSelfRegister(
  store: SyncStore,
  litellm: LitellmConfig,
  body: unknown,
  isAdmin: boolean,
): Promise<JsonResponse> {
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'invalid body' } };
  }
  const { name, userId, displayName, profile } = body as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) {
    return { status: 400, body: { error: 'missing name' } };
  }

  // Existing-user path: attach a new device, return the user's existing key.
  if (userId !== undefined) {
    if (typeof userId !== 'string' || !userId) {
      return { status: 400, body: { error: 'invalid userId' } };
    }
    const user = await store.getUser(userId);
    if (!user) {
      return { status: 404, body: { error: 'unknown user' } };
    }
    const { deviceId, deviceToken } = await provisionDevice(store, { userId, name: name.trim() });
    return {
      status: 200,
      body: { deviceId, userId, deviceToken, litellmKey: user.litellmKey, profile: user.profile },
    };
  }

  // New-user signup path: create user + mint LiteLLM key, then a device.
  if (typeof displayName !== 'string' || !displayName.trim()) {
    return { status: 400, body: { error: 'missing displayName' } };
  }
  // Profile is a user attribute. Open signups default to (and may only be) 'kid';
  // creating a non-kid user requires the admin token.
  let requestedProfile = 'kid';
  if (profile !== undefined) {
    if (typeof profile !== 'string' || !PROFILE_MODELS[profile]) {
      return { status: 400, body: { error: 'invalid profile' } };
    }
    requestedProfile = profile;
  }
  if (requestedProfile !== 'kid' && !isAdmin) {
    return { status: 403, body: { error: 'admin token required for non-kid profile' } };
  }
  const provisioned = await provisionUser(store, litellm, {
    displayName: displayName.trim(),
    profile: requestedProfile,
  });
  const { deviceId, deviceToken } = await provisionDevice(store, {
    userId: provisioned.userId,
    name: name.trim(),
  });
  return {
    status: 200,
    body: {
      deviceId,
      userId: provisioned.userId,
      deviceToken,
      litellmKey: provisioned.litellmKey,
      profile: provisioned.profile,
    },
  };
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

type Auth =
  | { kind: 'admin' }
  | { kind: 'device'; userId: string }
  | { kind: 'session'; userId: string };

async function resolveAuth(
  req: IncomingMessage,
  store: SyncStore,
  adminToken: string,
): Promise<Auth | null> {
  const tok = bearer(req);
  if (!tok) return null;
  if (tok === adminToken) return { kind: 'admin' };
  const device = await store.resolveDeviceToken(hashToken(tok));
  if (device) return { kind: 'device', userId: device.userId };
  const session = await store.resolveSession(hashToken(tok));
  if (session) return { kind: 'session', userId: session.userId };
  return null;
}

export function createSyncHttpServer(
  store: SyncStore,
  adminToken: string,
  litellm: LitellmConfig,
  memorySearch?: MemorySearchFn,
): http.Server {
  if (!adminToken) {
    throw new Error('createSyncHttpServer: adminToken is required');
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';

      // Open self-registration: no auth on the tailnet. A device provisions its
      // own token + LiteLLM key (new user) or attaches to an existing user.
      if (method === 'POST' && url.pathname === '/devices/register') {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch {
          send(res, 400, { error: 'invalid json' });
          return;
        }
        const result = await handleSelfRegister(
          store,
          litellm,
          body,
          bearer(req) === adminToken,
        );
        send(res, result.status, result.body);
        return;
      }

      const auth = await resolveAuth(req, store, adminToken);
      if (!auth) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }

      // user the request is allowed to act as: device + session tokens are locked
      // to their own user; only the admin token may target any user via ?user=.
      const scopedUser =
        auth.kind === 'admin' ? (url.searchParams.get('user') ?? undefined) : auth.userId;

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
            auth.kind === 'admin' ? undefined : auth.userId,
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
