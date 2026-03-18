import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, getDiscordToken, getEmailPassword } from '../src/config.js';

const MINIMAL_TOML = `
[discord]
token_env = "TEST_DISCORD_TOKEN"
allowed_user_ids = ["111"]
guild_id = "222"

[models]
default = "qwen3:30b-a3b"
coding = "qwen2.5-coder:32b"
complex = "glm-4.7-flash"
ollama_base_url = "http://localhost:11434"

[schedule]
timezone = "America/New_York"
email_triage_cron = "0 8 * * *"
daily_summary_cron = "0 9 * * *"

[email]
accounts = []
`;

const TOML_WITH_EMAIL_ACCOUNT = `
[discord]
token_env = "TEST_DISCORD_TOKEN"
allowed_user_ids = ["111"]
guild_id = "222"

[models]
default = "qwen3:30b-a3b"
coding = "qwen2.5-coder:32b"
complex = "glm-4.7-flash"
ollama_base_url = "http://localhost:11434"

[schedule]
timezone = "America/New_York"
email_triage_cron = "0 8 * * *"
daily_summary_cron = "0 9 * * *"

[[email.accounts]]
name = "personal"
host = "imap.gmail.com"
port = 993
username = "user@gmail.com"
password_env = "TEST_EMAIL_PASSWORD"
ssl = true
folders = ["INBOX"]
`;

let configPath: string;

beforeEach(() => {
  configPath = join(tmpdir(), `config-test-${Date.now()}.toml`);
});

afterEach(() => {
  try { unlinkSync(configPath); } catch { /* already gone */ }
  delete process.env.CONFIG_PATH;
  delete process.env.TEST_DISCORD_TOKEN;
  delete process.env.TEST_EMAIL_PASSWORD;
});

describe('loadConfig', () => {
  it('parses a valid TOML file and returns a structured Config', () => {
    writeFileSync(configPath, MINIMAL_TOML);
    process.env.CONFIG_PATH = configPath;
    process.env.TEST_DISCORD_TOKEN = 'tok-abc';

    const config = loadConfig();

    expect(config.discord.token_env).toBe('TEST_DISCORD_TOKEN');
    expect(config.discord.guild_id).toBe('222');
    expect(config.models.default).toBe('qwen3:30b-a3b');
    expect(config.email.accounts).toHaveLength(0);
  });

  it('throws when the discord token env var is not set', () => {
    writeFileSync(configPath, MINIMAL_TOML);
    process.env.CONFIG_PATH = configPath;
    // TEST_DISCORD_TOKEN intentionally not set

    expect(() => loadConfig()).toThrow('TEST_DISCORD_TOKEN');
  });

  it('throws when an email account password env var is not set', () => {
    writeFileSync(configPath, TOML_WITH_EMAIL_ACCOUNT);
    process.env.CONFIG_PATH = configPath;
    process.env.TEST_DISCORD_TOKEN = 'tok-abc';
    // TEST_EMAIL_PASSWORD intentionally not set

    expect(() => loadConfig()).toThrow('TEST_EMAIL_PASSWORD');
  });
});

describe('getDiscordToken', () => {
  it('returns the value of the env var named by token_env', () => {
    process.env.TEST_DISCORD_TOKEN = 'tok-xyz';
    const token = getDiscordToken({ discord: { token_env: 'TEST_DISCORD_TOKEN' } } as any);
    expect(token).toBe('tok-xyz');
  });
});

describe('getEmailPassword', () => {
  it('returns the value of the env var named by password_env', () => {
    process.env.TEST_EMAIL_PASSWORD = 'secret123';
    const pw = getEmailPassword({ password_env: 'TEST_EMAIL_PASSWORD' });
    expect(pw).toBe('secret123');
  });
});
