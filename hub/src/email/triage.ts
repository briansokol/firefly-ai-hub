import type { FetchedEmail } from './imap.js';

export interface TriageResult {
  summary: string;
  actionItems: string[];
  urgent: boolean;
}

const SYSTEM_PROMPT = `You are an email triage assistant. Analyze the email and respond with ONLY a JSON object — no prose, no markdown, no explanation — matching this exact schema:
{
  "summary": "<one or two sentence summary of the email>",
  "actionItems": ["<action item 1>", "<action item 2>"],
  "urgent": <true if the email requires a response or action today, otherwise false>
}
If there are no action items, use an empty array.`;

export function buildTriagePrompt(email: FetchedEmail): { system: string; user: string } {
  const date = email.date.toISOString().slice(0, 10);
  const user = `From: ${email.from}
Subject: ${email.subject}
Date: ${date}

${email.text}`.trim();

  return { system: SYSTEM_PROMPT, user };
}

export function parseTriageResponse(raw: string): TriageResult {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    const parsed = JSON.parse(cleaned) as Partial<TriageResult>;

    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : raw.slice(0, 500),
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.filter(
        (item): item is string => typeof item === 'string',
      ) : [],
      urgent: parsed.urgent === true,
    };
  } catch {
    return { summary: raw.slice(0, 500), actionItems: [], urgent: false };
  }
}
