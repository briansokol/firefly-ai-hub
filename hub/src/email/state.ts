import Database from 'better-sqlite3';

export interface CategorizationEntry {
  account: string;
  uid: number;
  subject: string;
  sender: string;
  category: string;
  reason: string;
  needsResponse: boolean;
}

export interface CategoryCount {
  category: string;
  count: number;
}

export interface StateStore {
  getLastUid(account: string): number;
  setLastUid(account: string, uid: number): void;
  logCategorization(entry: CategorizationEntry): void;
  getTodaySummary(account: string): CategoryCount[];
  getTodayNeedsResponse(account: string): CategorizationEntry[];
  close(): void;
}

export function createStateStore(dbPath: string): StateStore {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS uid_state (
      account  TEXT    PRIMARY KEY,
      last_uid INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS categorization_log (
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
  `);

  const getStmt = db.prepare<[string], { last_uid: number }>(
    'SELECT last_uid FROM uid_state WHERE account = ?'
  );
  const upsertStmt = db.prepare<[string, number]>(
    'INSERT INTO uid_state (account, last_uid) VALUES (?, ?)' +
    ' ON CONFLICT(account) DO UPDATE SET last_uid = excluded.last_uid'
  );

  const logStmt = db.prepare<[string, number, string, string, string, string, number]>(
    `INSERT INTO categorization_log (account, uid, subject, sender, category, reason, needs_response)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const summaryStmt = db.prepare<[string], { category: string; count: number }>(
    `SELECT category, COUNT(*) as count FROM categorization_log
     WHERE account = ? AND date(created_at) = date('now')
     GROUP BY category ORDER BY count DESC`
  );

  const needsResponseStmt = db.prepare<[string], { account: string; uid: number; subject: string; sender: string; category: string; reason: string; needs_response: number }>(
    `SELECT account, uid, subject, sender, category, reason, needs_response FROM categorization_log
     WHERE account = ? AND date(created_at) = date('now') AND needs_response = 1
     ORDER BY id DESC`
  );

  return {
    getLastUid(account: string): number {
      return getStmt.get(account)?.last_uid ?? 0;
    },
    setLastUid(account: string, uid: number): void {
      upsertStmt.run(account, uid);
    },
    logCategorization(entry: CategorizationEntry): void {
      logStmt.run(
        entry.account,
        entry.uid,
        entry.subject,
        entry.sender,
        entry.category,
        entry.reason,
        entry.needsResponse ? 1 : 0,
      );
    },
    getTodaySummary(account: string): CategoryCount[] {
      return summaryStmt.all(account);
    },
    getTodayNeedsResponse(account: string): CategorizationEntry[] {
      return needsResponseStmt.all(account).map((row) => ({
        account: row.account,
        uid: row.uid,
        subject: row.subject,
        sender: row.sender,
        category: row.category,
        reason: row.reason,
        needsResponse: row.needs_response === 1,
      }));
    },
    close(): void {
      db.close();
    },
  };
}
