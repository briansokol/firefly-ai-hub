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

  it('soft-deletes a conversation and syncs the tombstone under LWW', async () => {
    const conv = '55555555-5555-5555-5555-555555555555';
    const t1 = '2026-06-06T10:00:00.000Z';
    const t2 = '2026-06-06T10:00:05.000Z';

    // Create, then delete by setting deleted_at and bumping updated_at.
    await store.push({ conversations: [{ id: conv, user_id: userId, title: 'doomed', created_at: t1, updated_at: t1 }] });
    await store.push({ conversations: [{ id: conv, user_id: userId, title: 'doomed', created_at: t1, updated_at: t2, deleted_at: t2 }] });

    // A client whose cursor predates the delete sees the tombstone on pull.
    const delta = await store.pull(t1, userId);
    expect(delta.conversations.find((c) => c.id === conv)?.deleted_at).toBe(t2);

    // A stale un-delete (older updated_at) must NOT clobber the tombstone.
    await store.push({ conversations: [{ id: conv, user_id: userId, title: 'doomed', created_at: t1, updated_at: t1, deleted_at: null }] });
    const { rows } = await store.pool.query<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM conversations WHERE id = $1',
      [conv],
    );
    expect(rows[0].deleted_at).not.toBeNull();
  });

  it('getMessagesSince excludes messages from soft-deleted conversations', async () => {
    const live = '66666666-6666-6666-6666-666666666666';
    const dead = '77777777-7777-7777-7777-777777777777';
    const t = '2026-06-07T10:00:00.000Z';

    await store.push({
      conversations: [
        { id: live, user_id: userId, title: 'live', created_at: t, updated_at: t },
        { id: dead, user_id: userId, title: 'dead', created_at: t, updated_at: t, deleted_at: t },
      ],
      messages: [
        { id: '6666aaa1-0000-0000-0000-000000000001', conversation_id: live, role: 'user', content: 'keep me', model: null, created_at: t },
        { id: '7777aaa1-0000-0000-0000-000000000001', conversation_id: dead, role: 'user', content: 'skip me', model: null, created_at: t },
      ],
    });

    const contents = (await store.getMessagesSince(userId, EPOCH)).map((m) => m.content);
    expect(contents).toContain('keep me');
    expect(contents).not.toContain('skip me');
  });

  it('a renamed conversation syncs its new title to other clients via pull', async () => {
    const conv = '88888888-8888-8888-8888-888888888888';
    const t1 = '2026-06-08T10:00:00.000Z';
    const t2 = '2026-06-08T10:00:05.000Z';

    await store.push({ conversations: [{ id: conv, user_id: userId, title: 'first name', created_at: t1, updated_at: t1 }] });
    await store.push({ conversations: [{ id: conv, user_id: userId, title: 'renamed', created_at: t1, updated_at: t2 }] });

    // A client whose cursor predates the rename pulls the new title.
    const delta = await store.pull(t1, userId);
    expect(delta.conversations.find((c) => c.id === conv)?.title).toBe('renamed');
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
