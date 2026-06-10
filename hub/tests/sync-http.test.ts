import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createSyncHttpServer } from '../src/sync/http.js';
import type { SyncStore } from '../src/sync/store.js';
import { ScopeViolationError } from '../src/sync/store.js';
import { hashToken } from '../src/sync/provision.js';

const DEVICE_USER = 'user-device';

// Minimal in-memory stub of the parts of SyncStore the HTTP layer touches.
function stubStore(): SyncStore {
  return {
    pool: {} as never,
    async getDefaultUserId() {
      return 'user-default';
    },
    async resolveDeviceToken(hash: string) {
      return hash === hashToken('devtoken') ? { deviceId: 'dev1', userId: DEVICE_USER } : null;
    },
    async pull(_since: string, userId?: string) {
      return { conversations: [], messages: [], memories: [], cursor: `pulled:${userId}` };
    },
    async push(_p, enforceUserId?: string) {
      if (enforceUserId === DEVICE_USER) throw new ScopeViolationError('blocked');
    },
    // unused-by-http members:
    registerDevice: async () => ({ deviceId: 'd', userId: 'user-default' }),
    createUser: async () => ({ userId: '' }),
    setUserLitellmKey: async () => {},
    getUserLitellmKey: async () => null,
    createDevice: async () => ({ deviceId: '' }),
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
  server = createSyncHttpServer(stubStore(), 'admin-secret');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => server.close());

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

  it('admin-only: device token cannot register a device', async () => {
    const res = await fetch(`${baseUrl}/devices/register`, {
      method: 'POST',
      headers: { ...auth('devtoken'), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', userId: 'u' }),
    });
    expect(res.status).toBe(403);
  });
});
