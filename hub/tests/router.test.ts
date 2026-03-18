import { describe, it, expect } from 'vitest';
import { isAllowed, stripMention, resolveRoute } from '../src/discord/router.js';
import type { Config } from '../src/types.js';

const config: Config = {
  discord: {
    token_env: 'DISCORD_TOKEN',
    allowed_user_ids: ['111', '222'],
    guild_id: '999',
  },
  models: {
    default: 'qwen3:30b-a3b',
    coding: 'qwen2.5-coder:32b',
    complex: 'glm-4.7-flash',
    ollama_base_url: 'http://localhost:11434/v1',
  },
  schedule: {
    timezone: 'America/New_York',
    email_triage_cron: '0 7 * * *',
    daily_summary_cron: '0 21 * * *',
  },
  email: { accounts: [] },
};

describe('isAllowed', () => {
  it('returns true for a user ID in the allowlist', () => {
    expect(isAllowed('111', config)).toBe(true);
  });

  it('returns false for a user ID not in the allowlist', () => {
    expect(isAllowed('999', config)).toBe(false);
  });
});

describe('stripMention', () => {
  it('strips a standard mention from the start of a message', () => {
    expect(stripMention('<@123456> hello bot')).toBe('hello bot');
  });

  it('strips a nickname mention (with !) from the start of a message', () => {
    expect(stripMention('<@!123456> hello bot')).toBe('hello bot');
  });
});

describe('resolveRoute', () => {
  it('routes #general to the default model with sandbox false', () => {
    const route = resolveRoute('general', 'what is the weather?', config);
    expect(route.model).toBe('qwen3:30b-a3b');
    expect(route.sandbox).toBe(false);
    expect(route.content).toBe('what is the weather?');
  });

  it('routes #coding to the coding model with sandbox true', () => {
    const route = resolveRoute('coding', 'fix this function', config);
    expect(route.model).toBe('qwen2.5-coder:32b');
    expect(route.sandbox).toBe(true);
  });

  it('routes /think prefix to the complex model and strips the prefix', () => {
    const route = resolveRoute('general', '/think explain quantum entanglement', config);
    expect(route.model).toBe('glm-4.7-flash');
    expect(route.content).toBe('explain quantum entanglement');
    expect(route.sandbox).toBe(false);
  });

  it('/think prefix takes priority over channel name', () => {
    const route = resolveRoute('coding', '/think plan this refactor', config);
    expect(route.model).toBe('glm-4.7-flash');
    expect(route.sandbox).toBe(false);
  });
});
