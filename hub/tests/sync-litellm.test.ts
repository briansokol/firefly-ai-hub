import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateVirtualKey, PROFILE_MODELS } from '../src/sync/litellm.js';

afterEach(() => vi.restoreAllMocks());

describe('litellm virtual keys', () => {
  it('maps profiles to model allow-lists', () => {
    expect(PROFILE_MODELS.adult).toEqual(['fast', 'code', 'chat-heavy', 'frontier']);
    expect(PROFILE_MODELS.kid).toEqual(['fast', 'chat-heavy']);
  });

  it('POSTs to /key/generate with master auth + allow-list and returns the key', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ key: 'sk-generated' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const key = await generateVirtualKey(
      { baseUrl: 'http://litellm:4000', masterKey: 'sk-master' },
      { models: PROFILE_MODELS.kid, keyAlias: 'kid-alice' },
    );

    expect(key).toBe('sk-generated');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://litellm:4000/key/generate');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer sk-master');
    const body = JSON.parse(init.body as string);
    expect(body.models).toEqual(['fast', 'chat-heavy']);
    expect(body.key_alias).toBe('kid-alice');
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await expect(
      generateVirtualKey({ baseUrl: 'http://litellm:4000', masterKey: 'bad' }, { models: ['fast'] }),
    ).rejects.toThrow(/key\/generate failed/i);
  });
});
