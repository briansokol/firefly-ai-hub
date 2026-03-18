import Database from 'better-sqlite3';

export interface StateStore {
  getLastUid(account: string): number;
  setLastUid(account: string, uid: number): void;
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

  const getStmt = db.prepare<[string], { last_uid: number }>(
    'SELECT last_uid FROM uid_state WHERE account = ?'
  );
  const upsertStmt = db.prepare<[string, number]>(
    'INSERT INTO uid_state (account, last_uid) VALUES (?, ?)' +
    ' ON CONFLICT(account) DO UPDATE SET last_uid = excluded.last_uid'
  );

  return {
    getLastUid(account: string): number {
      return getStmt.get(account)?.last_uid ?? 0;
    },
    setLastUid(account: string, uid: number): void {
      upsertStmt.run(account, uid);
    },
    close(): void {
      db.close();
    },
  };
}
