import type { FetchedEmail } from './imap.js';

export interface CategorizeResult {
  category: string;
  confidence: number;
  reason: string;
  needsResponse: boolean;
}

const SYSTEM_PROMPT = `You are an email categorization assistant. Classify the email into exactly one category.

Categories:
- Newsletters: Regular newsletters, marketing emails, digest updates, mailing lists, promotional offers, automated reports
- Bills: Bills, invoices, payment confirmations, subscription charges, bank statements, financial notifications, receipts
- VIP: Personal emails from real people (not automated), job-related correspondence, account security alerts, appointment confirmations, direct messages that expect a reply
- Other: Anything that doesn't clearly fit the above categories. When in doubt, choose Other.

Also determine if the email expects or requires a response from the recipient.

Respond with ONLY a JSON object — no prose, no markdown, no explanation:
{"category": "<category name>", "confidence": <0.0-1.0>, "reason": "<brief one-sentence explanation>", "needsResponse": <true if the email expects a reply, otherwise false>}`;

export function buildCategorizePrompt(email: FetchedEmail): { system: string; user: string } {
  const d = email.date instanceof Date ? email.date : new Date(email.date as unknown as string);
  const date = d.toISOString().slice(0, 10);
  const user = `From: ${email.from}
Subject: ${email.subject}
Date: ${date}

${email.text}`.trim();

  return { system: SYSTEM_PROMPT, user };
}

export function parseCategorizeResponse(
  raw: string,
  validCategories: string[],
  defaultCategory: string,
): CategorizeResult {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    const parsed = JSON.parse(cleaned) as Partial<CategorizeResult>;

    const category = typeof parsed.category === 'string' && validCategories.includes(parsed.category)
      ? parsed.category
      : defaultCategory;

    return {
      category,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'Unable to parse reason',
      needsResponse: parsed.needsResponse === true,
    };
  } catch {
    return {
      category: defaultCategory,
      confidence: 0,
      reason: 'Failed to parse LLM response',
      needsResponse: false,
    };
  }
}
