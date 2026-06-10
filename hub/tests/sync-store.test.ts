import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSyncStore, type SyncStore, EPOCH } from '../src/sync/store.js';

// Integration test against a real Postgres. Skipped unless SYNC_TEST_DB_URL is set
// (keeps `npm test` hermetic). The URL should point at a maintenance-capable role
// and a target database name the test may create, e.g.
//   SYNC_TEST_DB_URL=postgres://test:test@127.0.0.1:55432/firefly_sync_test
const DB_URL = process.env.SYNC_TEST_DB_URL;

describe.skipIf(!DB_URL)('sync store (Postgres)', () => {
  let store: SyncStore;
  let userId: string;

  beforeAll(async () => {
    store = await createSyncStore(DB_URL as string);
    // Clean slate for repeatable runs.
    await store.pool.query('TRUNCATE messages, conversations, memories, devices RESTART IDENTITY CASCADE');
    userId = await store.getDefaultUserId();
  });

  afterAll(async () => {
    if (store) await store.close();
  });

  it('registers a device and returns ids', async () => {
    const { deviceId, userId: uid } = await store.registerDevice(userId, 'framework');
    expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(uid).toBe(userId);
  });

  it('syncs disjoint messages between two devices and is idempotent on replay', async () => {
    const convA = '11111111-1111-1111-1111-111111111111';
    const convB = '22222222-2222-2222-2222-222222222222';
    const t1 = '2026-06-04T10:00:00.000Z';
    const t2 = '2026-06-04T10:00:01.000Z';
    const t3 = '2026-06-04T10:00:02.000Z';

    // Device A pushes conversation A + one message.
    const pushA = {
      conversations: [
        { id: convA, user_id: userId, title: 'A', created_at: t1, updated_at: t1 },
      ],
      messages: [
        { id: 'aaaaaaa1-0000-0000-0000-000000000001', conversation_id: convA, role: 'user', content: 'hi from A', model: 'fast', created_at: t1 },
      ],
    };
    await store.push(pushA);

    // Device B pushes conversation B + one message (disjoint).
    const pushB = {
      conversations: [
        { id: convB, user_id: userId, title: 'B', created_at: t2, updated_at: t2 },
      ],
      messages: [
        { id: 'bbbbbbb1-0000-0000-0000-000000000001', conversation_id: convB, role: 'user', content: 'hi from B', model: 'fast', created_at: t3 },
      ],
    };
    await store.push(pushB);

    // A full pull from EPOCH sees both conversations and both messages.
    const full = await store.pull(EPOCH, userId);
    expect(full.conversations.map((c) => c.id).sort()).toEqual([convA, convB].sort());
    expect(full.messages).toHaveLength(2);
    expect(full.cursor).toBe(t3);

    // A device that already had A's data (cursor=t1) pulls only B's newer rows.
    const delta = await store.pull(t1, userId);
    expect(delta.conversations.map((c) => c.id)).toEqual([convB]);
    expect(delta.messages.map((m) => m.content)).toEqual(['hi from B']);

    // Replaying device A's push is a no-op (no duplicate message rows).
    await store.push(pushA);
    const { rows } = await store.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM messages');
    expect(rows[0].n).toBe('2');
  });

  it('applies last-write-wins on conversation title by updated_at', async () => {
    const conv = '33333333-3333-3333-3333-333333333333';
    const early = '2026-06-04T11:00:00.000Z';
    const late = '2026-06-04T11:00:05.000Z';
    await store.push({ conversations: [{ id: conv, user_id: userId, title: 'old', created_at: early, updated_at: early }] });
    await store.push({ conversations: [{ id: conv, user_id: userId, title: 'new', created_at: early, updated_at: late }] });
    // A stale write (older updated_at) must not clobber the newer title.
    await store.push({ conversations: [{ id: conv, user_id: userId, title: 'stale', created_at: early, updated_at: early }] });
    const { rows } = await store.pool.query<{ title: string }>('SELECT title FROM conversations WHERE id = $1', [conv]);
    expect(rows[0].title).toBe('new');
  });

  it('creates a user with a profile and stores its litellm key', async () => {
    const { userId: uid } = await store.createUser('Brian', 'adult');
    expect(uid).toMatch(/^[0-9a-f-]{36}$/);
    await store.setUserLitellmKey(uid, 'sk-test-123');
    expect(await store.getUserLitellmKey(uid)).toBe('sk-test-123');

    const { rows } = await store.pool.query<{ profile: string }>(
      'SELECT profile FROM users WHERE id = $1',
      [uid],
    );
    expect(rows[0].profile).toBe('adult');
  });

  it('creates a device with a token hash and resolves it back to the user', async () => {
    const { userId: uid } = await store.createUser('Kid', 'kid');
    const { deviceId } = await store.createDevice(uid, 'kid-ipad', 'hash-abc');
    expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);

    const resolved = await store.resolveDeviceToken('hash-abc');
    expect(resolved).toEqual({ deviceId, userId: uid });

    expect(await store.resolveDeviceToken('nope')).toBeNull();
  });

  it('rejects a push whose rows belong to a different user (scope enforcement)', async () => {
    const { userId: owner } = await store.createUser('Owner', 'adult');
    const { userId: attacker } = await store.createUser('Attacker', 'adult');
    const conv = '44444444-4444-4444-4444-444444444444';
    const t = '2026-06-05T10:00:00.000Z';

    await expect(
      store.push(
        { conversations: [{ id: conv, user_id: owner, title: 'x', created_at: t, updated_at: t }] },
        attacker, // enforceUserId — must not match owner's rows
      ),
    ).rejects.toThrow(/scope/i);

    // Same payload is fine when enforced against the real owner.
    await expect(
      store.push(
        { conversations: [{ id: conv, user_id: owner, title: 'x', created_at: t, updated_at: t }] },
        owner,
      ),
    ).resolves.toBeUndefined();
  });
});
