// Schema for the firefly_sync Postgres database. Applied idempotently on boot.
// Messages are append-only; conversations and memories are last-write-wins by updated_at.
// Postgres 13+ provides gen_random_uuid() in core, so no extension is needed.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   UUID NOT NULL REFERENCES users(id),
  name      TEXT NOT NULL,
  last_sync TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS conversations (
  id         UUID PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id),
  title      TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  model           TEXT,
  created_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id),
  text                TEXT NOT NULL,
  source_conversation UUID REFERENCES conversations(id),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-user watermark for the memory-distillation workflow (F2).
CREATE TABLE IF NOT EXISTS distill_cursor (
  user_id           UUID PRIMARY KEY REFERENCES users(id),
  last_distilled_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch'
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations (user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories (user_id, updated_at);

-- F3: multi-user. profile drives the LiteLLM model allow-list; litellm_key is the
-- per-user virtual key. Existing rows default to 'adult'.
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile TEXT NOT NULL DEFAULT 'adult';
ALTER TABLE users ADD COLUMN IF NOT EXISTS litellm_key TEXT;

-- F3: per-device bearer token, stored as a SHA-256 hex hash (never plaintext).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS token_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_token_hash ON devices (token_hash);

-- Conversation soft-delete tombstone. NULL = active; non-null = the deletion time.
-- A delete is a normal LWW update that sets deleted_at and bumps updated_at, so it
-- propagates through /sync/push + /sync/pull like any other conversation change.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
`;
