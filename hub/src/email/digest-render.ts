import type { CategorizationEntry } from './state.js';

export function extractSenderName(from: string): string {
  const trimmed = from.trim();
  const match = trimmed.match(/^"?(.*?)"?\s*<[^>]+>$/);
  if (match && match[1].length > 0) {
    return match[1].trim();
  }
  return trimmed;
}

export function renderCategoryThread(
  category: string,
  entries: CategorizationEntry[],
): string {
  const lines: string[] = [`**${category}** (${entries.length})`];
  for (const entry of entries) {
    const marker = entry.needsResponse ? '🚨 ' : '';
    const sender = extractSenderName(entry.sender);
    lines.push(`• ${marker}**${sender}** — *${entry.subject}*`);
    if (entry.summary.trim().length > 0) {
      lines.push(`  ${entry.summary}`);
    }
  }
  return lines.join('\n');
}
