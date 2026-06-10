import pg from 'pg';
import { SCHEMA_SQL } from './schema.js';

const { Pool, Client } = pg;

/** Thrown when a device token tries to push/read rows outside its own user. */
export class ScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeViolationError';
  }
}

export interface ConversationRow {
  id: string;
  user_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  model: string | null;
  created_at: string;
}

export interface MemoryRow {
  id: string;
  user_id: string;
  text: string;
  source_conversation: string | null;
  updated_at: string;
}

export interface PushPayload {
  conversations?: ConversationRow[];
  messages?: MessageRow[];
  memories?: MemoryRow[];
}

export interface PullResult {
  conversations: ConversationRow[];
  messages: MessageRow[];
  memories: MemoryRow[];
  cursor: string;
}

export interface DistillMessage {
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface SyncStore {
  getDefaultUserId(): Promise<string>;
  registerDevice(userId: string, name: string): Promise<{ deviceId: string; userId: string }>;
  createUser(displayName: string, profile: string): Promise<{ userId: string }>;
  setUserLitellmKey(userId: string, key: string): Promise<void>;
  getUserLitellmKey(userId: string): Promise<string | null>;
  createDevice(userId: string, name: string, tokenHash: string): Promise<{ deviceId: string }>;
  resolveDeviceToken(tokenHash: string): Promise<{ deviceId: string; userId: string } | null>;
  push(payload: PushPayload, enforceUserId?: string): Promise<void>;
  pull(since: string, userId?: string): Promise<PullResult>;
  // --- Memory distillation (F2) ---
  listUserIds(): Promise<string[]>;
  getDistillCursor(userId: string): Promise<string>;
  setDistillCursor(userId: string, isoTimestamp: string): Promise<void>;
  getMessagesSince(userId: string, since: string): Promise<DistillMessage[]>;
  insertMemory(userId: string, text: string, sourceConversation: string | null): Promise<MemoryRow>;
  getMemoriesByIds(ids: string[]): Promise<MemoryRow[]>;
  close(): Promise<void>;
  /** Exposed for tests and the distillation workflow. */
  readonly pool: pg.Pool;
}

/** Default cursor when a client has never synced. */
export const EPOCH = '1970-01-01T00:00:00.000Z';

function databaseName(connectionString: string): string {
  const u = new URL(connectionString);
  return u.pathname.replace(/^\//, '');
}

function maintenanceUrl(connectionString: string): string {
  const u = new URL(connectionString);
  u.pathname = '/postgres';
  return u.toString();
}

/** Connect to the maintenance DB and CREATE DATABASE if it does not exist. */
async function ensureDatabase(connectionString: string): Promise<void> {
  const dbName = databaseName(connectionString);
  const admin = new Client({ connectionString: maintenanceUrl(connectionString) });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rowCount === 0) {
      // Identifier cannot be parameterized; dbName comes from our own config, not user input.
      await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }
}

export async function createSyncStore(connectionString: string): Promise<SyncStore> {
  await ensureDatabase(connectionString);
  const pool = new Pool({ connectionString });

  await pool.query(SCHEMA_SQL);

  // Seed a single user (F1 is single-user; F3 adds the rest).
  await pool.query(
    `INSERT INTO users (display_name)
     SELECT 'default'
     WHERE NOT EXISTS (SELECT 1 FROM users)`,
  );

  async function getDefaultUserId(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM users ORDER BY created_at ASC LIMIT 1',
    );
    if (rows.length === 0) throw new Error('no users seeded');
    return rows[0].id;
  }

  return {
    pool,

    getDefaultUserId,

    async registerDevice(userId, name) {
      const { rows } = await pool.query<{ id: string }>(
        'INSERT INTO devices (user_id, name) VALUES ($1, $2) RETURNING id',
        [userId, name],
      );
      return { deviceId: rows[0].id, userId };
    },

    async createUser(displayName, profile) {
      const { rows } = await pool.query<{ id: string }>(
        'INSERT INTO users (display_name, profile) VALUES ($1, $2) RETURNING id',
        [displayName, profile],
      );
      return { userId: rows[0].id };
    },

    async setUserLitellmKey(userId, key) {
      await pool.query('UPDATE users SET litellm_key = $2 WHERE id = $1', [userId, key]);
    },

    async getUserLitellmKey(userId) {
      const { rows } = await pool.query<{ litellm_key: string | null }>(
        'SELECT litellm_key FROM users WHERE id = $1',
        [userId],
      );
      return rows[0]?.litellm_key ?? null;
    },

    async createDevice(userId, name, tokenHash) {
      const { rows } = await pool.query<{ id: string }>(
        'INSERT INTO devices (user_id, name, token_hash) VALUES ($1, $2, $3) RETURNING id',
        [userId, name, tokenHash],
      );
      return { deviceId: rows[0].id };
    },

    async resolveDeviceToken(tokenHash) {
      const { rows } = await pool.query<{ id: string; user_id: string }>(
        'SELECT id, user_id FROM devices WHERE token_hash = $1',
        [tokenHash],
      );
      if (rows.length === 0) return null;
      return { deviceId: rows[0].id, userId: rows[0].user_id };
    },

    async push(payload, enforceUserId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (enforceUserId) {
          for (const c of payload.conversations ?? []) {
            if (c.user_id !== enforceUserId) {
              throw new ScopeViolationError('conversation user_id outside device scope');
            }
          }
          for (const mem of payload.memories ?? []) {
            if (mem.user_id !== enforceUserId) {
              throw new ScopeViolationError('memory user_id outside device scope');
            }
          }
          // Messages carry no user_id; verify each referenced conversation belongs to
          // the device's user (checking the batch first, then existing rows).
          const batchConvOwner = new Map(
            (payload.conversations ?? []).map((c) => [c.id, c.user_id]),
          );
          for (const m of payload.messages ?? []) {
            if (batchConvOwner.get(m.conversation_id) === enforceUserId) continue;
            const { rows } = await client.query<{ user_id: string }>(
              'SELECT user_id FROM conversations WHERE id = $1',
              [m.conversation_id],
            );
            if (rows[0]?.user_id !== enforceUserId) {
              throw new ScopeViolationError('message conversation outside device scope');
            }
          }
        }

        for (const c of payload.conversations ?? []) {
          await client.query(
            `INSERT INTO conversations (id, user_id, title, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id) DO UPDATE SET
               title = EXCLUDED.title,
               updated_at = EXCLUDED.updated_at
             WHERE EXCLUDED.updated_at >= conversations.updated_at`,
            [c.id, c.user_id, c.title ?? null, c.created_at, c.updated_at],
          );
        }

        // Messages are append-only: re-pushing the same id is a no-op.
        for (const m of payload.messages ?? []) {
          await client.query(
            `INSERT INTO messages (id, conversation_id, role, content, model, created_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO NOTHING`,
            [m.id, m.conversation_id, m.role, m.content, m.model ?? null, m.created_at],
          );
        }

        for (const mem of payload.memories ?? []) {
          await client.query(
            `INSERT INTO memories (id, user_id, text, source_conversation, updated_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id) DO UPDATE SET
               text = EXCLUDED.text,
               source_conversation = EXCLUDED.source_conversation,
               updated_at = EXCLUDED.updated_at
             WHERE EXCLUDED.updated_at >= memories.updated_at`,
            [mem.id, mem.user_id, mem.text, mem.source_conversation ?? null, mem.updated_at],
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async pull(since, userId) {
      const uid = userId ?? (await getDefaultUserId());

      const conversations = (
        await pool.query<ConversationRow>(
          `SELECT id, user_id, title,
                  to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
                  to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
           FROM conversations
           WHERE user_id = $1 AND updated_at > $2
           ORDER BY updated_at ASC`,
          [uid, since],
        )
      ).rows;

      const messages = (
        await pool.query<MessageRow>(
          `SELECT m.id, m.conversation_id, m.role, m.content, m.model,
                  to_char(m.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           WHERE c.user_id = $1 AND m.created_at > $2
           ORDER BY m.created_at ASC`,
          [uid, since],
        )
      ).rows;

      const memories = (
        await pool.query<MemoryRow>(
          `SELECT id, user_id, text, source_conversation,
                  to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
           FROM memories
           WHERE user_id = $1 AND updated_at > $2
           ORDER BY updated_at ASC`,
          [uid, since],
        )
      ).rows;

      // Cursor = max timestamp returned this pull (or the incoming cursor if empty).
      let cursor = since;
      for (const c of conversations) if (c.updated_at > cursor) cursor = c.updated_at;
      for (const m of messages) if (m.created_at > cursor) cursor = m.created_at;
      for (const mem of memories) if (mem.updated_at > cursor) cursor = mem.updated_at;

      return { conversations, messages, memories, cursor };
    },

    async listUserIds() {
      const { rows } = await pool.query<{ id: string }>('SELECT id FROM users');
      return rows.map((r) => r.id);
    },

    async getDistillCursor(userId) {
      const { rows } = await pool.query<{ ts: string }>(
        `SELECT to_char(last_distilled_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts
         FROM distill_cursor WHERE user_id = $1`,
        [userId],
      );
      return rows[0]?.ts ?? EPOCH;
    },

    async setDistillCursor(userId, isoTimestamp) {
      await pool.query(
        `INSERT INTO distill_cursor (user_id, last_distilled_at)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET last_distilled_at = EXCLUDED.last_distilled_at`,
        [userId, isoTimestamp],
      );
    },

    async getMessagesSince(userId, since) {
      const { rows } = await pool.query<DistillMessage>(
        `SELECT m.conversation_id, m.role, m.content,
                to_char(m.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE c.user_id = $1 AND m.created_at > $2
         ORDER BY m.created_at ASC`,
        [userId, since],
      );
      return rows;
    },

    async insertMemory(userId, text, sourceConversation) {
      const { rows } = await pool.query<MemoryRow>(
        `INSERT INTO memories (user_id, text, source_conversation)
         VALUES ($1, $2, $3)
         RETURNING id, user_id, text, source_conversation,
                   to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`,
        [userId, text, sourceConversation],
      );
      return rows[0];
    },

    async getMemoriesByIds(ids) {
      if (ids.length === 0) return [];
      const { rows } = await pool.query<MemoryRow>(
        `SELECT id, user_id, text, source_conversation,
                to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
         FROM memories WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      return rows;
    },

    async close() {
      await pool.end();
    },
  };
}
