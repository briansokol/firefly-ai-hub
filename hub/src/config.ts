import fs from 'node:fs';
import { parse } from 'smol-toml';
import type { Config, ShortsConfig } from './types.js';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

export function loadConfig(): Config {
  const configPath = process.env.CONFIG_PATH ?? '/opt/ai-hub/config.toml';
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = parse(raw) as unknown as Config;
  requireEnv(parsed.discord.token_env);
  for (const account of parsed.email?.accounts ?? []) {
    requireEnv(account.password_env);
  }
  if (parsed.shorts?.hosted_scoring?.enabled) {
    requireEnv(parsed.shorts.hosted_scoring.api_key_env);
  }
  return parsed;
}

export function getDiscordToken(config: Config): string {
  return requireEnv(config.discord.token_env);
}

export function getEmailPassword(account: { password_env: string }): string {
  return requireEnv(account.password_env);
}

export function getHostedScoringApiKey(config: ShortsConfig): string {
  if (!config.hosted_scoring) {
    throw new Error('hosted_scoring config is not set');
  }
  return requireEnv(config.hosted_scoring.api_key_env);
}
