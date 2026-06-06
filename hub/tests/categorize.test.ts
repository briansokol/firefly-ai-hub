import { describe, it, expect } from 'vitest';
import { buildCategorizePrompt, parseCategorizeResponse } from '../src/email/categorize.js';
import type { FetchedEmail } from '../src/email/imap.js';

const email: FetchedEmail = {
  uid: 42,
  subject: 'Your March statement is ready',
  from: 'Chase <alerts@chase.com>',
  date: new Date('2026-03-10T12:00:00Z'),
  text: 'Your March statement is available. Balance $1,247.82 due by March 25.',
};

const CATEGORIES = ['Alerts', 'Bills', 'Development', 'Newsletters', 'Orders', 'Other', 'Shipping', 'VIP'];

describe('buildCategorizePrompt', () => {
  it('asks the LLM for both reason and summary in the JSON schema', () => {
    const { system } = buildCategorizePrompt(email);
    expect(system).toContain('reason');
    expect(system).toContain('summary');
  });
});

describe('parseCategorizeResponse', () => {
  it('extracts the summary field when present', () => {
    const raw = JSON.stringify({
      category: 'Bills',
      confidence: 0.92,
      reason: 'Credit card statement',
      summary: 'March statement, $1,247.82 due March 25.',
      needsResponse: false,
    });
    const result = parseCategorizeResponse(raw, CATEGORIES, 'Other');
    expect(result.category).toBe('Bills');
    expect(result.reason).toBe('Credit card statement');
    expect(result.summary).toBe('March statement, $1,247.82 due March 25.');
  });

  it('defaults summary to empty string when the LLM omits the field', () => {
    const raw = JSON.stringify({
      category: 'Bills',
      confidence: 0.9,
      reason: 'Credit card statement',
      needsResponse: false,
    });
    const result = parseCategorizeResponse(raw, CATEGORIES, 'Other');
    expect(result.summary).toBe('');
    // The other fields must still parse correctly.
    expect(result.category).toBe('Bills');
    expect(result.reason).toBe('Credit card statement');
  });

  it('defaults summary to empty string on unparseable JSON', () => {
    const result = parseCategorizeResponse('garbage not json', CATEGORIES, 'Other');
    expect(result.summary).toBe('');
    expect(result.category).toBe('Other');
  });

  it('ignores non-string summary values rather than crashing', () => {
    const raw = JSON.stringify({
      category: 'Bills',
      reason: 'ok',
      summary: { nested: 'object' },
      needsResponse: false,
    });
    const result = parseCategorizeResponse(raw, CATEGORIES, 'Other');
    expect(result.summary).toBe('');
  });

  it('still strips markdown code fences and extracts summary', () => {
    const raw = '```json\n{"category":"VIP","reason":"personal","summary":"Friend checking in.","needsResponse":true}\n```';
    const result = parseCategorizeResponse(raw, CATEGORIES, 'Other');
    expect(result.category).toBe('VIP');
    expect(result.summary).toBe('Friend checking in.');
    expect(result.needsResponse).toBe(true);
  });
});
