import { describe, it, expect } from 'vitest';
import { buildTriagePrompt, parseTriageResponse } from '../src/email/triage.js';
import type { FetchedEmail } from '../src/email/imap.js';

const email: FetchedEmail = {
  uid: 101,
  subject: 'Invoice due tomorrow',
  from: 'Acme Corp <billing@acme.com>',
  date: new Date('2026-03-01T09:00:00Z'),
  text: 'Your invoice #4321 for $500 is due tomorrow. Please pay at your earliest convenience.',
};

describe('buildTriagePrompt', () => {
  it('includes the email subject in the user prompt', () => {
    const { user } = buildTriagePrompt(email);
    expect(user).toContain('Invoice due tomorrow');
  });

  it('includes the sender in the user prompt', () => {
    const { user } = buildTriagePrompt(email);
    expect(user).toContain('Acme Corp <billing@acme.com>');
  });

  it('includes the formatted date in the user prompt', () => {
    const { user } = buildTriagePrompt(email);
    expect(user).toContain('2026-03-01');
  });

  it('includes the body text in the user prompt', () => {
    const { user } = buildTriagePrompt(email);
    expect(user).toContain('invoice #4321');
  });

  it('includes a JSON schema hint in the system prompt', () => {
    const { system } = buildTriagePrompt(email);
    expect(system).toContain('actionItems');
    expect(system).toContain('urgent');
    expect(system).toContain('summary');
  });
});

describe('parseTriageResponse', () => {
  it('parses a valid JSON response', () => {
    const raw = JSON.stringify({
      summary: 'Invoice due tomorrow.',
      actionItems: ['Pay invoice #4321'],
      urgent: true,
    });
    const result = parseTriageResponse(raw);
    expect(result.summary).toBe('Invoice due tomorrow.');
    expect(result.actionItems).toEqual(['Pay invoice #4321']);
    expect(result.urgent).toBe(true);
  });

  it('strips markdown code fences before parsing', () => {
    const raw = '```json\n{"summary":"ok","actionItems":[],"urgent":false}\n```';
    const result = parseTriageResponse(raw);
    expect(result.summary).toBe('ok');
    expect(result.urgent).toBe(false);
  });

  it('returns urgent: false when urgent field is absent', () => {
    const raw = JSON.stringify({ summary: 'FYI email.', actionItems: [] });
    const result = parseTriageResponse(raw);
    expect(result.urgent).toBe(false);
  });

  it('filters non-string entries out of actionItems', () => {
    const raw = JSON.stringify({ summary: 'x', actionItems: ['do thing', 42, null], urgent: false });
    const result = parseTriageResponse(raw);
    expect(result.actionItems).toEqual(['do thing']);
  });

  it('falls back gracefully on invalid JSON', () => {
    const result = parseTriageResponse('not json at all');
    expect(result.summary).toBe('not json at all');
    expect(result.actionItems).toEqual([]);
    expect(result.urgent).toBe(false);
  });

  it('truncates the fallback summary to 500 chars on invalid JSON', () => {
    const long = 'x'.repeat(600);
    const result = parseTriageResponse(long);
    expect(result.summary).toHaveLength(500);
  });
});
