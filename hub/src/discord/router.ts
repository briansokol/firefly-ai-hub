import type { Config } from '../types.js';
import type { RgbPreset } from '../temporal/workflow-types.js';

export type { RgbPreset };

export interface Route {
  model: string;
  content: string;
  sandbox: boolean;
}

const RGB_PRESETS: RgbPreset[] = ['work', 'night', 'gaming', 'off'];

export function parseRgbCommand(content: string): RgbPreset | null {
  const match = content.match(/^!rgb\s+(\S+)$/i);
  if (!match) return null;
  const preset = match[1].toLowerCase();
  return (RGB_PRESETS as readonly string[]).includes(preset) ? (preset as RgbPreset) : null;
}

export function isAllowed(userId: string, config: Config): boolean {
  return config.discord.allowed_user_ids.includes(userId);
}

export function stripMention(content: string): string {
  return content.replace(/^<@!?\d+>\s*/, '').trim();
}

export function parseShortsCommand(content: string): { source: string } | null {
  const match = content.match(/^!shorts\s+(\S+)$/i);
  if (!match) return null;
  const source = match[1];
  // Accept HTTP(S) URLs or absolute paths
  if (!source.startsWith('http') && !source.startsWith('/')) return null;
  return { source };
}

export function parseCategorizeCommand(content: string): { accountName: string } | null {
  const match = content.match(/^!categorize(?:\s+(\S+))?$/i);
  if (!match) return null;
  return { accountName: match[1] ?? 'fastmail' };
}

export function parseShortsEditCommand(content: string): { workspaceName: string } | null {
  const match = content.match(/^!shorts-edit\s+(.+)$/i);
  if (!match) return null;
  const workspaceName = match[1].trim();
  if (!workspaceName) return null;
  return { workspaceName };
}

export function resolveRoute(channelName: string, content: string, config: Config): Route {
  if (content.startsWith('/think ')) {
    return {
      model: config.models.complex,
      content: content.slice('/think '.length).trim(),
      sandbox: false,
    };
  }
  if (channelName === 'coding') {
    return { model: config.models.coding, content, sandbox: true };
  }
  return { model: config.models.default, content, sandbox: false };
}
