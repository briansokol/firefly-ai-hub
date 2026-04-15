// Hub HTTP server. Originally memory-only; now also exposes /web/search and
// /web/fetch bridge routes consumed by the Open WebUI `hub_web_tools.py` Tool.
// The function name is kept for backwards compatibility with callers.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { MemoryStore } from './store.js';
import type { Config } from '../types.js';
import {
  braveSearch,
  BraveSearchError,
  type BraveResult,
} from '../tools/web-search.js';
import { fetchUrlAsText } from '../tools/fetch-url.js';

const VALID_CATEGORIES = new Set(['preference', 'fact', 'project', 'relationship']);

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

function handleRecall(
  memoryStore: MemoryStore,
  url: URL,
): JsonResponse {
  const user = url.searchParams.get('user');
  const q = url.searchParams.get('q') ?? '';
  const limitRaw = url.searchParams.get('limit');
  if (!user) return { status: 400, body: { error: 'missing user' } };
  const limit = limitRaw ? Math.max(1, Math.min(50, Number(limitRaw))) : 10;
  const memories = q
    ? memoryStore.searchMemories(user, q, limit)
    : memoryStore.getRecentMemories(user, limit);
  return { status: 200, body: { memories } };
}

function handleRecent(memoryStore: MemoryStore, url: URL): JsonResponse {
  const user = url.searchParams.get('user');
  const limitRaw = url.searchParams.get('limit');
  if (!user) return { status: 400, body: { error: 'missing user' } };
  const limit = limitRaw ? Math.max(1, Math.min(50, Number(limitRaw))) : 5;
  const memories = memoryStore.getRecentMemories(user, limit);
  return { status: 200, body: { memories } };
}

function handleRemember(memoryStore: MemoryStore, body: unknown): JsonResponse {
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'invalid body' } };
  }
  const { user, category, content } = body as Record<string, unknown>;
  if (typeof user !== 'string' || !user) {
    return { status: 400, body: { error: 'missing user' } };
  }
  if (typeof content !== 'string' || !content.trim()) {
    return { status: 400, body: { error: 'missing content' } };
  }
  const cat = typeof category === 'string' && VALID_CATEGORIES.has(category) ? category : 'fact';
  const id = memoryStore.addMemory(user, cat, content.trim());
  return { status: 200, body: { id } };
}

function handleForget(memoryStore: MemoryStore, body: unknown): JsonResponse {
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'invalid body' } };
  }
  const { id } = body as Record<string, unknown>;
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    return { status: 400, body: { error: 'missing id' } };
  }
  memoryStore.deactivateMemory(id);
  return { status: 200, body: { ok: true } };
}

async function handleWebSearch(config: Config, url: URL): Promise<JsonResponse> {
  const q = url.searchParams.get('q');
  if (!q || !q.trim()) {
    return { status: 400, body: { error: 'missing q' } };
  }
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Math.max(1, Math.min(10, Number(limitRaw) || 0)) : 5;

  const apiKeyEnv = config.tools?.web_search?.api_key_env;
  if (!apiKeyEnv) {
    return { status: 503, body: { error: 'web search not configured' } };
  }
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    return { status: 503, body: { error: 'web search not configured (missing API key)' } };
  }

  try {
    const results: BraveResult[] = await braveSearch(q, apiKey, limit);
    return { status: 200, body: { results } };
  } catch (err) {
    const status = err instanceof BraveSearchError && err.status ? 502 : 502;
    const message = err instanceof Error ? err.message : 'unknown error';
    return { status, body: { error: message } };
  }
}

async function handleWebFetch(config: Config, body: unknown): Promise<JsonResponse> {
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'invalid body' } };
  }
  const { url } = body as Record<string, unknown>;
  if (typeof url !== 'string' || !url.trim()) {
    return { status: 400, body: { error: 'missing url' } };
  }

  const fetchConfig = config.tools?.fetch_url;
  try {
    const result = await fetchUrlAsText(url, {
      maxBodyBytes: fetchConfig?.max_body_bytes,
      maxTextChars: fetchConfig?.max_text_chars,
      timeoutMs: fetchConfig?.timeout_ms,
      maxRedirects: fetchConfig?.max_redirects,
    });
    return {
      status: 200,
      body: {
        final_url: result.finalUrl,
        text: result.text,
        truncated: result.truncated,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return { status: 502, body: { error: message } };
  }
}

export function createMemoryHttpServer(
  memoryStore: MemoryStore,
  token: string,
  config: Config,
): http.Server {
  if (!token) {
    throw new Error('createMemoryHttpServer: token is required');
  }

  return http.createServer(async (req, res) => {
    try {
      if (req.headers['x-auth'] !== token) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/memory/recall') {
        const { status, body } = handleRecall(memoryStore, url);
        send(res, status, body);
        return;
      }

      if (method === 'GET' && url.pathname === '/memory/recent') {
        const { status, body } = handleRecent(memoryStore, url);
        send(res, status, body);
        return;
      }

      if (method === 'POST' && url.pathname === '/memory/remember') {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch {
          send(res, 400, { error: 'invalid json' });
          return;
        }
        const result = handleRemember(memoryStore, body);
        send(res, result.status, result.body);
        return;
      }

      if (method === 'POST' && url.pathname === '/memory/forget') {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch {
          send(res, 400, { error: 'invalid json' });
          return;
        }
        const result = handleForget(memoryStore, body);
        send(res, result.status, result.body);
        return;
      }

      if (method === 'GET' && url.pathname === '/web/search') {
        const { status, body } = await handleWebSearch(config, url);
        send(res, status, body);
        return;
      }

      if (method === 'POST' && url.pathname === '/web/fetch') {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch {
          send(res, 400, { error: 'invalid json' });
          return;
        }
        const result = await handleWebFetch(config, body);
        send(res, result.status, result.body);
        return;
      }

      send(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('memory http error:', err);
      send(res, 500, { error: 'internal error' });
    }
  });
}
