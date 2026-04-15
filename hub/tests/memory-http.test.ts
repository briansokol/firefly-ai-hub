import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMemoryHttpServer } from '../src/memory/http.js';
import { createMemoryStore, type MemoryStore } from '../src/memory/store.js';
import type { Config } from '../src/types.js';

const TOKEN = 'test-token-xyz';
const BRAVE_KEY_ENV = 'TEST_BRAVE_API_KEY';
const BRAVE_KEY_VALUE = 'fake-brave-token';

// Preserve the real `fetch` so tests can delegate localhost requests past
// whatever mock is active. The server the test exercises is on 127.0.0.1:<port>,
// so the mock must pass those calls through untouched.
const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);

function stubOutgoingFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : (input as Request).url;
    if (urlStr.includes('127.0.0.1')) {
      return realFetch(input as RequestInfo, init);
    }
    return handler(urlStr, init);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function makeConfig(overrides: Partial<Config['tools']> = {}): Config {
  return {
    discord: { token_env: 'X', allowed_user_ids: [], guild_id: '' },
    models: { default: '', coding: '', complex: '', ollama_base_url: '' },
    schedule: { timezone: 'UTC', email_triage_cron: '', daily_summary_cron: '' },
    email: { accounts: [] },
    tools: {
      web_search: { provider: 'brave', api_key_env: BRAVE_KEY_ENV },
      ...overrides,
    },
  } as Config;
}

async function startServer(store: MemoryStore, config: Config) {
  const server = createMemoryHttpServer(store, TOKEN, config);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('memory http server', () => {
  let store: MemoryStore;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    store = createMemoryStore(':memory:');
    const started = await startServer(store, makeConfig());
    server = started.server;
    baseUrl = started.baseUrl;
    process.env[BRAVE_KEY_ENV] = BRAVE_KEY_VALUE;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    delete process.env[BRAVE_KEY_ENV];
    vi.unstubAllGlobals();
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

  describe('GET /web/search', () => {
    it('rejects requests without X-Auth', async () => {
      const res = await fetch(`${baseUrl}/web/search?q=test`);
      expect(res.status).toBe(401);
    });

    it('400s on missing query', async () => {
      const res = await fetch(`${baseUrl}/web/search`, authed());
      expect(res.status).toBe(400);
    });

    it('returns Brave results on success', async () => {
      const braveBody = {
        web: {
          results: [
            { title: 'Result A', url: 'https://a.example/', description: 'first' },
            { title: 'Result B', url: 'https://b.example/', description: 'second' },
          ],
        },
      };
      let sawBraveUrl = '';
      stubOutgoingFetch((url) => {
        sawBraveUrl = url;
        return new Response(JSON.stringify(braveBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      const res = await fetch(`${baseUrl}/web/search?q=mars&limit=2`, authed());
      expect(res.status).toBe(200);
      const json = (await res.json()) as { results: { title: string; url: string }[] };
      expect(json.results).toHaveLength(2);
      expect(json.results[0]?.title).toBe('Result A');
      expect(sawBraveUrl).toContain('api.search.brave.com');
      expect(sawBraveUrl).toContain('q=mars');
    });

    it('returns 502 when Brave fails', async () => {
      stubOutgoingFetch(() => new Response('upstream down', { status: 503 }));
      const res = await fetch(`${baseUrl}/web/search?q=anything`, authed());
      expect(res.status).toBe(502);
    });
  });

  describe('GET /web/search (not configured)', () => {
    let s2: Server;
    let base2: string;
    beforeEach(async () => {
      const started = await startServer(store, makeConfig({ web_search: undefined }));
      s2 = started.server;
      base2 = started.baseUrl;
    });
    afterEach(async () => {
      await new Promise<void>((resolve) => s2.close(() => resolve()));
    });

    it('returns 503 when tools.web_search is not configured', async () => {
      const res = await fetch(`${base2}/web/search?q=hi`, authed());
      expect(res.status).toBe(503);
    });

    it('returns 503 when the API key env var is unset', async () => {
      delete process.env[BRAVE_KEY_ENV];
      const res = await fetch(`${baseUrl}/web/search?q=hi`, authed());
      expect(res.status).toBe(503);
    });
  });

  describe('POST /web/fetch', () => {
    it('rejects requests without X-Auth', async () => {
      const res = await fetch(`${baseUrl}/web/fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com' }),
      });
      expect(res.status).toBe(401);
    });

    it('400s on missing url', async () => {
      const res = await fetch(
        `${baseUrl}/web/fetch`,
        authed({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
      );
      expect(res.status).toBe(400);
    });

    it('400s on invalid body', async () => {
      const res = await fetch(
        `${baseUrl}/web/fetch`,
        authed({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{bad',
        }),
      );
      expect(res.status).toBe(400);
    });

    it('returns extracted text on success', async () => {
      const html =
        '<html><head><title>t</title><style>.x{}</style></head>' +
        '<body><h1>Hello</h1><script>alert(1)</script>' +
        '<p>Paragraph <b>one</b>.</p></body></html>';
      stubOutgoingFetch(
        () =>
          new Response(html, {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
      );

      // Use an IP literal so the DNS pre-check is skipped (preflight sees
      // isIPv4 && !private and passes through).
      const res = await fetch(
        `${baseUrl}/web/fetch`,
        authed({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'http://1.2.3.4/page' }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        final_url: string;
        text: string;
        truncated: boolean;
      };
      expect(json.final_url).toBe('http://1.2.3.4/page');
      expect(json.text).toContain('Hello');
      expect(json.text).toContain('Paragraph one.');
      expect(json.text).not.toContain('alert(1)');
      expect(json.truncated).toBe(false);
    });

    it('sets truncated=true when text exceeds maxTextChars', async () => {
      const longHtml = '<html><body>' + 'a'.repeat(20_000) + '</body></html>';
      stubOutgoingFetch(
        () =>
          new Response(longHtml, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      );
      const res = await fetch(
        `${baseUrl}/web/fetch`,
        authed({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'http://1.2.3.4/' }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { text: string; truncated: boolean };
      expect(json.truncated).toBe(true);
      expect(json.text.length).toBe(15_000);
    });

    it('blocks loopback IPs (SSRF) at preflight', async () => {
      // Use a routable non-private IP literal so the happy-path tests still
      // work — but for SSRF, send the loopback literal. validateUrlPreflight
      // rejects it before safeFetch ever calls fetch().
      const res = await fetch(
        `${baseUrl}/web/fetch`,
        authed({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'http://127.0.0.1/memory/recall' }),
        }),
      );
      expect(res.status).toBe(502);
      const json = (await res.json()) as { error: string };
      expect(json.error).toMatch(/private\/internal IP/);
    });

    it('502s on upstream fetch failure', async () => {
      stubOutgoingFetch(() => new Response('nope', { status: 500 }));
      const res = await fetch(
        `${baseUrl}/web/fetch`,
        authed({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'http://1.2.3.4/' }),
        }),
      );
      expect(res.status).toBe(502);
    });
  });

  describe('unknown routes', () => {
    it('404s for unknown paths', async () => {
      const res = await fetch(`${baseUrl}/nope`, authed());
      expect(res.status).toBe(404);
    });
  });
});
