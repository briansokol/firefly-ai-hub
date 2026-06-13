import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createSyncHttpServer } from '../src/sync/http.js';
import type { SyncStore } from '../src/sync/store.js';
import { ScopeViolationError } from '../src/sync/store.js';
import { hashToken } from '../src/sync/provision.js';
import { hashPassword } from '../src/sync/auth.js';

// Real scrypt hash of the login test password, computed once in beforeAll.
let KNOWN_HASH: string;

const DEVICE_USER = 'user-device';
const SESSION_TOKEN = 'sesstoken';
const DEVICE_TOKEN = 'devtoken';
const OWNED_DEVICE = '00000000-0000-0000-0000-0000000000a1';
const FOREIGN_DEVICE = '00000000-0000-0000-0000-0000000000b2';

// Minimal in-memory stub of the parts of SyncStore the HTTP layer touches.
function stubStore(): SyncStore {
  return {
    pool: {} as never,
    async getDefaultUserId() {
      return 'user-default';
    },
    async resolveDeviceToken(hash: string) {
      return hash === hashToken(DEVICE_TOKEN) ? { deviceId: 'dev1', userId: DEVICE_USER } : null;
    },
    async resolveSession(hash: string) {
      return hash === hashToken(SESSION_TOKEN) ? { userId: DEVICE_USER } : null;
    },
    // username/password + login
    async isUsernameTaken(username: string) {
      return username === 'dupe';
    },
    async createUserWithLogin() {
      return { userId: 'new-user-id' };
    },
    async getUserByUsername(username: string) {
      if (username === 'known')
        return { userId: DEVICE_USER, passwordHash: KNOWN_HASH, profile: 'kid', litellmKey: 'sk-known' };
      if (username === 'legacy')
        return { userId: 'legacy-user', passwordHash: null, profile: 'kid', litellmKey: null };
      return null;
    },
    async createSession() {
      return { sessionId: 'sess-1' };
    },
    deleteSession: async () => {},
    // device management
    async listDevices(uid: string) {
      return [{ id: OWNED_DEVICE, name: 'macbook', lastSync: null }].filter(() => uid === DEVICE_USER);
    },
    async getDevice(deviceId: string) {
      if (deviceId === OWNED_DEVICE) return { deviceId: OWNED_DEVICE, userId: DEVICE_USER };
      if (deviceId === FOREIGN_DEVICE) return { deviceId: FOREIGN_DEVICE, userId: 'user-other' };
      return null;
    },
    rotateDeviceToken: async () => {},
    deleteDevice: async () => {},
    async pull(_since: string, userId?: string) {
      return { conversations: [], messages: [], memories: [], cursor: `pulled:${userId}` };
    },
    async push(_p, enforceUserId?: string) {
      if (enforceUserId === DEVICE_USER) throw new ScopeViolationError('blocked');
    },
    // unused-by-http members:
    registerDevice: async () => ({ deviceId: 'd', userId: 'user-default' }),
    createUser: async () => ({ userId: 'new-user-id' }),
    setUserLitellmKey: async () => {},
    getUserLitellmKey: async () => null,
    getUser: async (userId: string) =>
      userId === 'existing-user' ? { profile: 'adult', litellmKey: 'sk-existing' } : null,
    createDevice: async () => ({ deviceId: 'new-device-id' }),
    listUserIds: async () => [],
    getDistillCursor: async () => '',
    setDistillCursor: async () => {},
    getMessagesSince: async () => [],
    insertMemory: async () => ({
      id: '',
      user_id: '',
      text: '',
      source_conversation: null,
      updated_at: '',
    }),
    getMemoriesByIds: async () => [],
    close: async () => {},
  } as unknown as SyncStore;
}

let baseUrl: string;
let server: ReturnType<typeof createSyncHttpServer>;

beforeAll(async () => {
  KNOWN_HASH = await hashPassword('rightpass');
  server = createSyncHttpServer(stubStore(), 'admin-secret', {
    baseUrl: 'http://litellm.test',
    masterKey: 'sk-master',
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => server.close());

afterEach(() => vi.unstubAllGlobals());

const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });

describe('sync http auth + scoping', () => {
  it('rejects an unknown bearer with 401', async () => {
    const res = await fetch(`${baseUrl}/sync/pull`, { headers: auth('garbage') });
    expect(res.status).toBe(401);
  });

  it('a device token pulls its own user and ignores ?user=', async () => {
    const res = await fetch(`${baseUrl}/sync/pull?user=someone-else`, { headers: auth('devtoken') });
    expect(res.status).toBe(200);
    expect((await res.json()).cursor).toBe('pulled:user-device');
  });

  it('the admin token can target any user via ?user=', async () => {
    const res = await fetch(`${baseUrl}/sync/pull?user=user-x`, { headers: auth('admin-secret') });
    expect(res.status).toBe(200);
    expect((await res.json()).cursor).toBe('pulled:user-x');
  });

  it('a cross-user push from a device returns 403', async () => {
    const res = await fetch(`${baseUrl}/sync/push`, {
      method: 'POST',
      headers: { ...auth('devtoken'), 'content-type': 'application/json' },
      body: JSON.stringify({ conversations: [] }),
    });
    expect(res.status).toBe(403);
  });

  it('POST /devices/register is removed (authenticated -> 404 not found)', async () => {
    const res = await fetch(`${baseUrl}/devices/register`, {
      method: 'POST',
      headers: { ...auth(SESSION_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', displayName: 'y' }),
    });
    expect(res.status).toBe(404);
  });

  it('a session token cannot push another user\'s rows (scope enforced)', async () => {
    const res = await fetch(`${baseUrl}/sync/push`, {
      method: 'POST',
      headers: { ...auth(SESSION_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ conversations: [] }),
    });
    expect(res.status).toBe(403);
  });
});

// Mock the LiteLLM /key/generate call (signup mints a virtual key).
function stubLitellm() {
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) =>
    typeof url === 'string' && url.startsWith('http://litellm.test')
      ? new Response(JSON.stringify({ key: 'sk-user-key' }), { status: 200 })
      : realFetch(url, init),
  );
}

describe('auth signup/login', () => {
  it('signup creates a kid user and returns a session token + litellm key', async () => {
    stubLitellm();
    const res = await fetch(`${baseUrl}/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Kiddo', password: 'longenough', displayName: 'Kiddo' }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.profile).toBe('kid');
    expect(typeof j.sessionToken).toBe('string');
    expect(typeof j.litellmKey).toBe('string');
    expect(j.deviceToken).toBeUndefined();
    expect(j.username).toBe('kiddo'); // lowercased
  });

  it('signup requesting adult without admin token -> 403', async () => {
    const res = await fetch(`${baseUrl}/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'grown', password: 'longenough', displayName: 'G', profile: 'adult' }),
    });
    expect(res.status).toBe(403);
  });

  it('signup adult with admin token -> 200 adult', async () => {
    stubLitellm();
    const res = await fetch(`${baseUrl}/auth/signup`, {
      method: 'POST',
      headers: { ...auth('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'grown2', password: 'longenough', displayName: 'G', profile: 'adult' }),
    });
    expect((await res.json()).profile).toBe('adult');
  });

  it('signup with a taken username -> 409', async () => {
    const res = await fetch(`${baseUrl}/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'dupe', password: 'longenough', displayName: 'D' }),
    });
    expect(res.status).toBe(409);
  });

  it('signup rejects bad username / short password / missing displayName -> 400', async () => {
    for (const body of [
      { username: 'a', password: 'longenough', displayName: 'X' }, // too short
      { username: 'okname', password: 'short', displayName: 'X' }, // password < 8
      { username: 'okname', password: 'longenough' }, // no displayName
    ]) {
      const res = await fetch(`${baseUrl}/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it('login with correct password -> 200 + sessionToken + devices', async () => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'known', password: 'rightpass' }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(typeof j.sessionToken).toBe('string');
    expect(Array.isArray(j.devices)).toBe(true);
  });

  it('login wrong password / unknown user / legacy null-hash all -> 401 invalid credentials', async () => {
    for (const body of [
      { username: 'known', password: 'wrong' },
      { username: 'nobody', password: 'whatever' },
      { username: 'legacy', password: 'whatever' },
    ]) {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe('invalid credentials');
    }
  });
});

describe('device management', () => {
  it('GET /devices lists the caller\'s devices (session token)', async () => {
    const res = await fetch(`${baseUrl}/devices`, { headers: auth(SESSION_TOKEN) });
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).devices)).toBe(true);
  });

  it('GET /devices also works with a device token', async () => {
    const res = await fetch(`${baseUrl}/devices`, { headers: auth(DEVICE_TOKEN) });
    expect(res.status).toBe(200);
  });

  it('GET /devices with no token -> 401', async () => {
    const res = await fetch(`${baseUrl}/devices`);
    expect(res.status).toBe(401);
  });

  it('POST /devices registers a new device, returns deviceToken + litellmKey', async () => {
    const res = await fetch(`${baseUrl}/devices`, {
      method: 'POST',
      headers: { ...auth(SESSION_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'macbook' }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(typeof j.deviceToken).toBe('string');
  });

  it('POST /devices missing name -> 400', async () => {
    const res = await fetch(`${baseUrl}/devices`, {
      method: 'POST',
      headers: { ...auth(SESSION_TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('POST /devices/:id/claim rotates the token (returns a new one)', async () => {
    const res = await fetch(`${baseUrl}/devices/${OWNED_DEVICE}/claim`, {
      method: 'POST',
      headers: auth(SESSION_TOKEN),
    });
    expect(res.status).toBe(200);
    expect(typeof (await res.json()).deviceToken).toBe('string');
  });

  it('claiming a device owned by another user -> 404', async () => {
    const res = await fetch(`${baseUrl}/devices/${FOREIGN_DEVICE}/claim`, {
      method: 'POST',
      headers: auth(SESSION_TOKEN),
    });
    expect(res.status).toBe(404);
  });

  it('DELETE /devices/:id removes an owned device; foreign -> 404', async () => {
    const ok = await fetch(`${baseUrl}/devices/${OWNED_DEVICE}`, {
      method: 'DELETE',
      headers: auth(SESSION_TOKEN),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);

    const foreign = await fetch(`${baseUrl}/devices/${FOREIGN_DEVICE}`, {
      method: 'DELETE',
      headers: auth(SESSION_TOKEN),
    });
    expect(foreign.status).toBe(404);
  });
});
