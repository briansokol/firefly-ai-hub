import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createStateStore, type CategorizationEntry } from '../src/email/state.js';

// Use in-memory SQLite so tests leave no files on disk
const DB = ':memory:';

describe('createStateStore', () => {
  let store: ReturnType<typeof createStateStore>;

  afterEach(() => {
    store.close();
  });

  it('returns 0 for an account that has never been seen', () => {
    store = createStateStore(DB);
    expect(store.getLastUid('gmail')).toBe(0);
  });

  it('stores and retrieves a UID for an account', () => {
    store = createStateStore(DB);
    store.setLastUid('gmail', 42);
    expect(store.getLastUid('gmail')).toBe(42);
  });

  it('keeps UIDs isolated per account', () => {
    store = createStateStore(DB);
    store.setLastUid('gmail', 100);
    store.setLastUid('work', 200);
    expect(store.getLastUid('gmail')).toBe(100);
    expect(store.getLastUid('work')).toBe(200);
  });

  it('updates the UID when called again for the same account', () => {
    store = createStateStore(DB);
    store.setLastUid('gmail', 10);
    store.setLastUid('gmail', 99);
    expect(store.getLastUid('gmail')).toBe(99);
  });
});

describe('categorization_log', () => {
  let store: ReturnType<typeof createStateStore>;
  let dbPath: string;

  afterEach(() => {
    store.close();
    if (dbPath && existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
  });

  function makeEntry(overrides: Partial<CategorizationEntry> = {}): CategorizationEntry {
    return {
      account: 'fastmail',
      uid: 100,
      subject: 'Test subject',
      sender: 'Alice <alice@example.com>',
      category: 'Bills',
      reason: 'Contains an invoice',
      summary: 'February statement ready; balance $42 due March 15.',
      needsResponse: false,
      ...overrides,
    };
  }

  it('round-trips the summary field through logCategorization and getRecentCategorizations', () => {
    store = createStateStore(DB);
    const entry = makeEntry();
    store.logCategorization(entry);

    const rows = store.getRecentCategorizations('fastmail', 24);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe(entry.summary);
    expect(rows[0].subject).toBe(entry.subject);
    expect(rows[0].sender).toBe(entry.sender);
    expect(rows[0].category).toBe('Bills');
    expect(rows[0].needsResponse).toBe(false);
  });

  it('excludes rows whose created_at is older than the requested window', () => {
    dbPath = join(tmpdir(), `state-test-${Date.now()}-${Math.random()}.db`);
    store = createStateStore(dbPath);

    store.logCategorization(makeEntry({ uid: 1, subject: 'recent' }));
    store.logCategorization(makeEntry({ uid: 2, subject: 'stale' }));

    // Backdate the second row by 25 hours via a separate connection.
    const raw = new Database(dbPath);
    raw.prepare(
      `UPDATE categorization_log SET created_at = datetime('now', '-25 hours') WHERE uid = ?`
    ).run(2);
    raw.close();

    const rows = store.getRecentCategorizations('fastmail', 24);
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe('recent');
  });

  it('isolates rows by account', () => {
    store = createStateStore(DB);
    store.logCategorization(makeEntry({ account: 'fastmail', uid: 1 }));
    store.logCategorization(makeEntry({ account: 'gmail', uid: 2 }));

    const rows = store.getRecentCategorizations('fastmail', 24);
    expect(rows).toHaveLength(1);
    expect(rows[0].account).toBe('fastmail');
  });

  it('returns rows grouped by category so callers can group-by in one pass', () => {
    store = createStateStore(DB);
    store.logCategorization(makeEntry({ uid: 1, category: 'Bills', subject: 'b1' }));
    store.logCategorization(makeEntry({ uid: 2, category: 'VIP', subject: 'v1' }));
    store.logCategorization(makeEntry({ uid: 3, category: 'Bills', subject: 'b2' }));
    store.logCategorization(makeEntry({ uid: 4, category: 'VIP', subject: 'v2' }));

    const rows = store.getRecentCategorizations('fastmail', 24);
    expect(rows).toHaveLength(4);
    const categories = rows.map((r) => r.category);
    const firstVip = categories.indexOf('VIP');
    const lastVip = categories.lastIndexOf('VIP');
    const firstBill = categories.indexOf('Bills');
    const lastBill = categories.lastIndexOf('Bills');
    expect(lastVip - firstVip).toBe(1);
    expect(lastBill - firstBill).toBe(1);
  });

  it('preserves existing rows when adding the summary column via idempotent migration', () => {
    dbPath = join(tmpdir(), `state-test-migrate-${Date.now()}-${Math.random()}.db`);

    // Simulate an existing DB that predates the summary column.
    const legacy = new Database(dbPath);
    legacy.prepare(`
      CREATE TABLE categorization_log (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        account        TEXT NOT NULL,
        uid            INTEGER NOT NULL,
        subject        TEXT,
        sender         TEXT,
        category       TEXT NOT NULL,
        reason         TEXT,
        needs_response INTEGER DEFAULT 0,
        created_at     TEXT DEFAULT (datetime('now'))
      )
    `).run();
    legacy.prepare(
      `INSERT INTO categorization_log (account, uid, subject, sender, category, reason, needs_response)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('fastmail', 7, 'legacy row', 'old@example.com', 'Other', 'r', 0);
    legacy.close();

    // Opening the store must migrate the schema without data loss.
    store = createStateStore(dbPath);
    store.logCategorization(makeEntry({ uid: 8, subject: 'new row' }));

    const rows = store.getRecentCategorizations('fastmail', 24);
    expect(rows).toHaveLength(2);
    const legacyRow = rows.find((r) => r.uid === 7);
    const newRow = rows.find((r) => r.uid === 8);
    expect(legacyRow?.summary ?? '').toBe('');
    expect(newRow?.summary).toBe(
      'February statement ready; balance $42 due March 15.',
    );
  });
});
