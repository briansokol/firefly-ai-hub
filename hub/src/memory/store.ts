import Database from 'better-sqlite3';

export interface Memory {
  id: number;
  user_id: string;
  category: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryStore {
  addMemory(userId: string, category: string, content: string): number;
  searchMemories(userId: string, query: string, limit?: number): Memory[];
  getRecentMemories(userId: string, limit?: number): Memory[];
  getAllMemories(userId: string): Memory[];
  deactivateMemory(id: number): void;
  updateMemory(id: number, content: string): void;
  close(): void;
}

export function createMemoryStore(dbPath: string): MemoryStore {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL,
      category   TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      active     INTEGER DEFAULT 1
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_user
    ON memories(user_id, active)
  `);

  // FTS5 external content table for fast full-text search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(content, content=memories, content_rowid=id)
  `);

  // Triggers to keep FTS in sync with the memories table
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `);

  const insertStmt = db.prepare<[string, string, string]>(
    'INSERT INTO memories (user_id, category, content) VALUES (?, ?, ?)',
  );

  const searchStmt = db.prepare<[string, string, number]>(
    `SELECT m.id, m.user_id, m.category, m.content, m.created_at, m.updated_at
     FROM memories m
     JOIN memories_fts fts ON m.id = fts.rowid
     WHERE fts.content MATCH ? AND m.user_id = ? AND m.active = 1
     ORDER BY rank
     LIMIT ?`,
  );

  const recentStmt = db.prepare<[string, number]>(
    `SELECT id, user_id, category, content, created_at, updated_at
     FROM memories
     WHERE user_id = ? AND active = 1
     ORDER BY updated_at DESC
     LIMIT ?`,
  );

  const allStmt = db.prepare<[string]>(
    `SELECT id, user_id, category, content, created_at, updated_at
     FROM memories
     WHERE user_id = ? AND active = 1
     ORDER BY updated_at DESC`,
  );

  const deactivateStmt = db.prepare<[number]>(
    'UPDATE memories SET active = 0, updated_at = datetime(\'now\') WHERE id = ?',
  );

  const updateStmt = db.prepare<[string, number]>(
    'UPDATE memories SET content = ?, updated_at = datetime(\'now\') WHERE id = ?',
  );

  return {
    addMemory(userId: string, category: string, content: string): number {
      const result = insertStmt.run(userId, category, content);
      return Number(result.lastInsertRowid);
    },

    searchMemories(userId: string, query: string, limit = 10): Memory[] {
      try {
        // FTS5 query — escape special characters for safety
        const safeQuery = query.replace(/['"]/g, '').trim();
        if (!safeQuery) return this.getRecentMemories(userId, limit);
        return searchStmt.all(safeQuery, userId, limit) as Memory[];
      } catch {
        // If FTS query fails (bad syntax), fall back to recent
        return this.getRecentMemories(userId, limit);
      }
    },

    getRecentMemories(userId: string, limit = 5): Memory[] {
      return recentStmt.all(userId, limit) as Memory[];
    },

    getAllMemories(userId: string): Memory[] {
      return allStmt.all(userId) as Memory[];
    },

    deactivateMemory(id: number): void {
      deactivateStmt.run(id);
    },

    updateMemory(id: number, content: string): void {
      updateStmt.run(content, id);
    },

    close(): void {
      db.close();
    },
  };
}
