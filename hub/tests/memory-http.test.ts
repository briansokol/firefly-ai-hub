import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMemoryHttpServer } from '../src/memory/http.js';
import { createMemoryStore, type MemoryStore } from '../src/memory/store.js';

const TOKEN = 'test-token-xyz';

describe('memory http server', () => {
  let store: MemoryStore;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    store = createMemoryStore(':memory:');
    server = createMemoryHttpServer(store, TOKEN);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });

  const authed = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { ...(init.headers ?? {}), 'x-auth': TOKEN },
  });

  describe('auth', () => {
    it('rejects requests without X-Auth', async () => {
      const res = await fetch(`${baseUrl}/memory/recent?user=u1`);
      expect(res.status).toBe(401);
    });

    it('rejects requests with the wrong token', async () => {
      const res = await fetch(`${baseUrl}/memory/recent?user=u1`, {
        headers: { 'x-auth': 'wrong' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /memory/remember', () => {
    it('inserts a memory and returns the id', async () => {
      const res = await fetch(
        `${baseUrl}/memory/remember`,
        authed({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ user: 'u1', category: 'fact', content: 'likes coffee' }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { id: number };
      expect(json.id).toBeGreaterThan(0);

      const rows = store.getRecentMemories('u1', 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.content).toBe('likes coffee');
      expect(rows[0]?.category).toBe('fact');
    });

    it('defaults to category "fact" when category is missing or invalid', async () => {
      await fetch(
        `${baseUrl}/memory/remember`,
        authed({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ user: 'u1', content: 'no category given' }),
        }),
      );
      await fetch(
        `${baseUrl}/memory/remember`,
        authed({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ user: 'u1', category: 'bogus', content: 'invalid category' }),
        }),
      );
      const rows = store.getRecentMemories('u1', 10);
      expect(rows.map((r) => r.category)).toEqual(['fact', 'fact']);
    });

    it('400s on missing user or content', async () => {
      const noUser = await fetch(
        `${baseUrl}/memory/remember`,
        authed({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'hello' }),
        }),
      );
      expect(noUser.status).toBe(400);

      const noContent = await fetch(
        `${baseUrl}/memory/remember`,
        authed({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ user: 'u1' }),
        }),
      );
      expect(noContent.status).toBe(400);
    });

    it('400s on malformed JSON', async () => {
      const res = await fetch(
        `${baseUrl}/memory/remember`,
        authed({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{not json',
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('GET /memory/recall', () => {
    beforeEach(() => {
      store.addMemory('u1', 'fact', 'user likes coffee');
      store.addMemory('u1', 'preference', 'prefers dark mode');
      store.addMemory('u2', 'fact', 'other user info');
    });

    it('returns memories matching the FTS query', async () => {
      const res = await fetch(`${baseUrl}/memory/recall?user=u1&q=coffee`, authed());
      expect(res.status).toBe(200);
      const json = (await res.json()) as { memories: { content: string }[] };
      expect(json.memories).toHaveLength(1);
      expect(json.memories[0]?.content).toBe('user likes coffee');
    });

    it('isolates memories by user', async () => {
      const res = await fetch(`${baseUrl}/memory/recall?user=u1&q=user`, authed());
      const json = (await res.json()) as { memories: { content: string }[] };
      expect(json.memories.every((m) => !m.content.includes('other'))).toBe(true);
    });

    it('falls back to recent when q is empty', async () => {
      const res = await fetch(`${baseUrl}/memory/recall?user=u1`, authed());
      const json = (await res.json()) as { memories: unknown[] };
      expect(json.memories).toHaveLength(2);
    });

    it('400s on missing user', async () => {
      const res = await fetch(`${baseUrl}/memory/recall?q=coffee`, authed());
      expect(res.status).toBe(400);
    });
  });

  describe('GET /memory/recent', () => {
    it('returns recent memories for a user', async () => {
      store.addMemory('u1', 'fact', 'first');
      store.addMemory('u1', 'fact', 'second');
      const res = await fetch(`${baseUrl}/memory/recent?user=u1&limit=5`, authed());
      const json = (await res.json()) as { memories: { content: string }[] };
      expect(json.memories).toHaveLength(2);
    });
  });

  describe('POST /memory/forget', () => {
    it('deactivates a memory by id', async () => {
      const id = store.addMemory('u1', 'fact', 'to be forgotten');
      const res = await fetch(
        `${baseUrl}/memory/forget`,
        authed({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        }),
      );
      expect(res.status).toBe(200);
      expect(store.getRecentMemories('u1', 10)).toHaveLength(0);
    });

    it('400s on missing id', async () => {
      const res = await fetch(
        `${baseUrl}/memory/forget`,
        authed({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('unknown routes', () => {
    it('404s for unknown paths', async () => {
      const res = await fetch(`${baseUrl}/nope`, authed());
      expect(res.status).toBe(404);
    });
  });
});
