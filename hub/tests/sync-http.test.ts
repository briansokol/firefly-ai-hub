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

  it('self-registers a new user with no token (mints LiteLLM key)', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) =>
      typeof url === 'string' && url.startsWith('http://litellm.test')
        ? new Response(JSON.stringify({ key: 'sk-user-key' }), { status: 200 })
        : realFetch(url, init),
    );

    const res = await fetch(`${baseUrl}/devices/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'macbook', displayName: 'Kiddo', profile: 'kid' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe('new-user-id');
    expect(body.deviceId).toBe('new-device-id');
    expect(body.litellmKey).toBe('sk-user-key');
    expect(body.profile).toBe('kid');
    expect(typeof body.deviceToken).toBe('string');
    expect(body.deviceToken.length).toBeGreaterThan(0);
  });

  it('open signup with no profile defaults to kid', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) =>
      typeof url === 'string' && url.startsWith('http://litellm.test')
        ? new Response(JSON.stringify({ key: 'sk-user-key' }), { status: 200 })
        : realFetch(url, init),
    );

    const res = await fetch(`${baseUrl}/devices/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'macbook', displayName: 'Kiddo' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile).toBe('kid');
  });

  it('open signup requesting an adult profile is rejected with 403', async () => {
    const res = await fetch(`${baseUrl}/devices/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'macbook', displayName: 'Grown Up', profile: 'adult' }),
    });
    expect(res.status).toBe(403);
  });

  it('the admin token can create an adult user', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) =>
      typeof url === 'string' && url.startsWith('http://litellm.test')
        ? new Response(JSON.stringify({ key: 'sk-adult-key' }), { status: 200 })
        : realFetch(url, init),
    );

    const res = await fetch(`${baseUrl}/devices/register`, {
      method: 'POST',
      headers: { ...auth('admin-secret'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'macbook', displayName: 'Grown Up', profile: 'adult' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile).toBe('adult');
    expect(body.litellmKey).toBe('sk-adult-key');
  });

  it('self-registers a device under an existing user (returns existing key)', async () => {
    const res = await fetch(`${baseUrl}/devices/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'iphone', userId: 'existing-user' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe('existing-user');
    expect(body.litellmKey).toBe('sk-existing');
    expect(body.profile).toBe('adult');
    expect(typeof body.deviceToken).toBe('string');
  });

  it('rejects an unknown existing userId with 404', async () => {
    const res = await fetch(`${baseUrl}/devices/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'iphone', userId: 'nope' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects an unknown profile on signup with 400', async () => {
    const res = await fetch(`${baseUrl}/devices/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'macbook', displayName: 'X', profile: 'wizard' }),
    });
    expect(res.status).toBe(400);
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
