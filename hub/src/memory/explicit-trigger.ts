// Detects explicit "remember this" phrases in a user message and extracts the fact.
// Returns null if no trigger phrase is present.
//
// SOURCE OF TRUTH: this file is mirrored in deploy/open-webui/functions/hub_memory_filter.py.
// Any regex change must be ported there in lockstep.

const TRIGGER =
  /^\s*(?:please\s+|hey[,\s]+)?(?:remember(?:\s+(?:that|this))?|note\s+that|don'?t\s+forget(?:\s+that)?|save\s+this|make\s+a\s+note(?:\s+that)?)\b[:,]?\s*(.+)/i;

export interface ExplicitMemory {
  content: string;
}

// Words that can appear in the capture group due to regex backtracking
// (e.g. "remember that" falls back to matching just "remember" with "that" as the fact).
const CONNECTOR_FALLBACK = /^(?:that|this)$/i;

export function extractExplicitMemory(message: string): ExplicitMemory | null {
  if (!message) return null;
  const match = message.match(TRIGGER);
  if (!match) return null;
  const content = (match[1] ?? '').trim().replace(/[.!?]+$/, '').trim();
  if (content.length < 3) return null;
  if (CONNECTOR_FALLBACK.test(content)) return null;
  return { content };
}
