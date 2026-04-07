import type { FetchedEmail } from './imap.js';

export interface CategorizeResult {
  category: string;
  confidence: number;
  reason: string;
  needsResponse: boolean;
}

const SYSTEM_PROMPT = `You are an email categorization assistant. Classify the email into exactly one category.

Categories:
- Alerts: Notifications and alerts that don't fit any other category — password resets, security alerts, account notifications, system alerts, automated warnings.
- Bills: Subscription charges, invoices, payment due notices, bank statements, financial notifications. These are recurring or expected charges, not one-time purchase receipts.
- Development: Emails from GitHub, GitLab, Bitbucket, or similar developer platforms. Also includes web hosting notifications (e.g., domain registrars, cloud providers, CI/CD pipelines, server monitoring).
- Newsletters: Regular newsletters, marketing emails, digest updates, mailing lists, promotional offers, automated reports.
- Orders: Emails confirming a one-time purchase, order receipt, or order confirmation. These are typically from online retailers and represent a specific transaction, not a recurring charge.
- Shipping: Shipping confirmations, tracking updates, delivery notifications, package status updates.
- VIP: Personal emails from a real, identifiable human who is writing to you directly — not a company, brand, marketing team, or automated system. The email must read as genuine human correspondence, not a templated or bulk message.
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
