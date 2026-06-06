import { describe, it, expect } from 'vitest';
import { extractSenderName, renderCategoryThread } from '../src/email/digest-render.js';
import type { CategorizationEntry } from '../src/email/state.js';

function entry(overrides: Partial<CategorizationEntry> = {}): CategorizationEntry {
  return {
    account: 'fastmail',
    uid: 1,
    subject: 'Subject',
    sender: 'Alice <alice@example.com>',
    category: 'Bills',
    reason: 'Invoice',
    summary: 'Summary text.',
    needsResponse: false,
    ...overrides,
  };
}

describe('extractSenderName', () => {
  it('pulls the display name out of "Name <email>" format', () => {
    expect(extractSenderName('Chase <alerts@chase.com>')).toBe('Chase');
  });

  it('returns the whole string when no angle-bracket email is present', () => {
    expect(extractSenderName('alerts@chase.com')).toBe('alerts@chase.com');
  });

  it('falls back to the email when the display-name capture is empty', () => {
    expect(extractSenderName('<only@example.com>')).toBe('<only@example.com>');
  });

  it('trims surrounding whitespace on bare addresses', () => {
    expect(extractSenderName('  alice@example.com  ')).toBe('alice@example.com');
  });

  it('strips surrounding quotes from display names', () => {
    expect(extractSenderName('"Bob Smith" <bob@example.com>')).toBe('Bob Smith');
  });
});

describe('renderCategoryThread', () => {
  it('renders a plain-text heading with the category name and entry count', () => {
    const out = renderCategoryThread('Bills', [entry({ subject: 'Statement' })]);
    expect(out).toContain('Bills');
    expect(out).toContain('(1)');
  });

  it('renders one bullet per entry with sender, subject, and summary', () => {
    const entries = [
      entry({ uid: 1, sender: 'Chase <alerts@chase.com>', subject: 'Statement', summary: 'Feb statement ready.' }),
      entry({ uid: 2, sender: 'Verizon <bill@verizon.com>', subject: 'Your bill', summary: 'Wireless bill $94.' }),
    ];
    const out = renderCategoryThread('Bills', entries);
    expect(out).toContain('Chase');
    expect(out).toContain('Statement');
    expect(out).toContain('Feb statement ready.');
    expect(out).toContain('Verizon');
    expect(out).toContain('Your bill');
    expect(out).toContain('Wireless bill $94.');
  });

  it('prefixes a 🚨 marker on entries that need a response', () => {
    const entries = [
      entry({ uid: 1, subject: 'no reply needed', needsResponse: false }),
      entry({ uid: 2, subject: 'please reply', needsResponse: true }),
    ];
    const out = renderCategoryThread('VIP', entries);
    const needsLine = out.split('\n').find((line) => line.includes('please reply'));
    const calmLine = out.split('\n').find((line) => line.includes('no reply needed'));
    expect(needsLine).toBeDefined();
    expect(calmLine).toBeDefined();
    expect(needsLine).toContain('🚨');
    expect(calmLine).not.toContain('🚨');
  });

  it('stays under the 2000-char Discord limit for a realistic 8-email category', () => {
    const entries: CategorizationEntry[] = Array.from({ length: 8 }, (_, i) =>
      entry({
        uid: i,
        sender: `Sender ${i} <s${i}@example.com>`,
        subject: `Subject number ${i}, a moderately long subject line`,
        summary: 'A two-sentence summary describing what the email said. It is on the longer side, roughly one hundred characters.',
      }),
    );
    const out = renderCategoryThread('Newsletters', entries);
    expect(out.length).toBeLessThan(2000);
  });

  it('omits the summary line when summary is empty', () => {
    const out = renderCategoryThread('Bills', [entry({ summary: '' })]);
    // Each bullet has at most one trailing line. A missing summary must not
    // produce an empty trailing line or orphan whitespace.
    expect(out).not.toMatch(/\n\s*\n/);
  });
});
