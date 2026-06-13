import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the LiteLLM module so provisionUser's key minting is controllable.
vi.mock('../src/sync/litellm.js', async (orig) => {
  const actual = await orig<typeof import('../src/sync/litellm.js')>();
  return { ...actual, generateVirtualKey: vi.fn() };
});

import { provisionUser } from '../src/sync/provision.js';
import { generateVirtualKey } from '../src/sync/litellm.js';
import type { LitellmConfig } from '../src/sync/litellm.js';
import type { SyncStore } from '../src/sync/store.js';

const LITELLM: LitellmConfig = { baseUrl: 'http://litellm', masterKey: 'sk-master' };

function fakeStore(): SyncStore {
  return {
    createUserWithLogin: vi.fn(async () => ({ userId: 'user-1' })),
    setUserLitellmKey: vi.fn(async () => {}),
  } as unknown as SyncStore;
}

describe('provisionUser', () => {
  it('derives a unique userId-based LiteLLM alias (not the display name)', async () => {
    vi.mocked(generateVirtualKey).mockResolvedValue('sk-new');
    const store = fakeStore();

    const result = await provisionUser(store, LITELLM, {
      displayName: 'Brian',
      profile: 'kid',
      username: 'bsokol',
      passwordHash: 'scrypt$x',
    });

    expect(result.litellmKey).toBe('sk-new');
    const alias = vi.mocked(generateVirtualKey).mock.calls[0][1].keyAlias;
    expect(alias).toBe('kid-user-1'); // unique per user, never 'kid-brian'
  });
});
