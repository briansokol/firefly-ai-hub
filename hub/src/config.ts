import fs from 'node:fs';
import { parse } from 'smol-toml';
import type { Config } from './types.js';

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
  return parsed;
}

export function getDiscordToken(config: Config): string {
  return requireEnv(config.discord.token_env);
}

export function getEmailPassword(account: { password_env: string }): string {
  return requireEnv(account.password_env);
}
