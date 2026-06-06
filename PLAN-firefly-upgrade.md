# Firefly AI Hub — Upgrade Plan

> **For Claude Code.** This is an implementation plan for upgrading an existing self-hosted AI hub. Work through the phases in order. Each phase has explicit acceptance criteria — do not move on until they pass. Read the **Guardrails** section before writing any code; the security rules there are non-negotiable and override convenience.

---

## 1. Purpose

Upgrade the existing `firefly-ai-hub` so it can serve as the **home base** for a unified, multi-device local-AI system. Firefly becomes:

1. A **model gateway** (LiteLLM) that exposes logical model names and routes them to the right backend, with a cloud fallback chain.
2. A **sync service** that owns conversation history and distilled "memories," which client devices sync against.
3. A **memory engine** that distills conversations into durable, embedded memories using the existing Temporal workflow engine.

A companion document (`PLAN-app-build.md`) covers the Tauri/Svelte client that consumes these services. Where the two intersect, this doc is the source of truth for the server-side contract.

---

## 2. Current State (already running on Firefly)

- **Hardware:** RTX 3090 (24 GB VRAM).
- **Inference:** Ollama, with `qwen3:30b`, `qwen2.5-coder:32b`, `glm-4.7-flash`.
- **Existing app:** TypeScript Discord bot + email triage. Repo: `github.com/briansokol/firefly-ai-hub`.
- **UI:** open-webui (keep it — it's the admin/power-user surface).
- **Workflow engine:** Temporal (currently underused).
- **Networking:** Tailscale mesh already in place.
- **Adjacent:** Synology DS1522+ NAS on the same network (runs other self-hosted apps; not part of this upgrade).

Treat the existing Discord/email functionality as **must-not-break**. New services run alongside it.

---

## 3. Target State (what this plan adds)

| Component | Tech | Role |
|---|---|---|
| **LiteLLM gateway** | `ghcr.io/berriai/litellm:main-latest` (Docker) | Logical model names → backends; fallback chain; auth key(s) |
| **Sync service** | TypeScript (match existing hub) on Node + Hono/Express | Delta-sync API for conversations, messages, memories |
| **Relational store** | PostgreSQL (reuse Temporal's instance or a sibling DB) | conversations / messages / memories / devices / users |
| **Vector store** | `qdrant/qdrant` (Docker) | Memory + RAG embeddings |
| **Memory distillation** | Temporal workflow (TS SDK) | Periodically summarize history → embed → store |
| **Embeddings** | Ollama (`nomic-embed-text` or `mxbai-embed-large`) | Reuse the 3090; OpenAI-compatible `/v1/embeddings` |

**Language decision (confirm before Phase F1):** the sync service and memory workflow are specified in **TypeScript** to live in the existing repo and reuse the Temporal TS SDK. LiteLLM stays a standalone container (no code). If a Python/FastAPI service is preferred instead, flag it and adjust — but default to TS for cohesion.

---

## 4. Architecture

```
                         Tailscale-only (no public exposure)
   client devices ──────────────────────────────────────────┐
                                                             ▼
┌──────────────────────────────── FIREFLY ────────────────────────────────┐
│                                                                          │
│  LiteLLM gateway  :4000   ──►  Ollama :11434  (qwen3:30b / coder / flash)│
│     • logical names: fast | code | chat-heavy | frontier                 │
│     • fallbacks: code→chat-heavy→frontier(cloud)                         │
│     • master key now; per-user virtual keys in Phase F3                  │
│                                                                          │
│  Sync service     :8787   ──►  Postgres  (conversations/messages/...)    │
│     • POST /sync/push   • GET /sync/pull   • POST /devices/register      │
│                                                                          │
│  Temporal worker          ──►  Ollama embeddings ──► Qdrant :6333        │
│     • scheduled memory-distillation workflow                            │
│                                                                          │
│  open-webui  (unchanged)        Discord bot + email triage (unchanged)  │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Guardrails (read before coding)

- **Never expose Ollama (`:11434`) or LiteLLM (`:4000`) on the public internet.** They bind to localhost / the tailnet interface only. Ollama has no auth; LiteLLM holds the Anthropic key. These are Tailscale-only, always.
- **No secrets in code or committed config.** All keys (`LITELLM_MASTER_KEY`, `ANTHROPIC_API_KEY`, DB creds) come from environment variables / a `.env` that is gitignored. The provided `litellm-config.yaml` already uses `os.environ/...` references — keep that pattern.
- **Do not break the existing Discord/email services.** Add new containers and services; do not refactor the working bot unless a task explicitly says so.
- **Bind new services to the tailnet interface,** not `0.0.0.0`, unless behind a reverse proxy that is itself tailnet-only.
- **Postgres:** if reusing Temporal's instance, create a **separate database** (e.g., `firefly_sync`), not new tables in Temporal's own DB.

---

## 6. Repo Layout (proposed additions)

```
firefly-ai-hub/
├─ docker-compose.yml          # add litellm + qdrant services
├─ gateway/
│  └─ litellm-config.yaml      # provided — logical names + fallbacks
├─ services/
│  └─ sync/                    # new TS service
│     ├─ src/
│     │  ├─ server.ts          # Hono/Express app: push/pull/register
│     │  ├─ db.ts              # pg pool + migrations runner
│     │  └─ schema.sql         # tables below
│     └─ package.json
├─ workflows/
│  └─ memory/                  # Temporal TS worker + workflow
│     ├─ distill.workflow.ts
│     └─ activities.ts         # summarize (LLM) + embed (Ollama) + upsert (Qdrant)
└─ .env.example                # documented, no real values
```

---

## 7. Data Model (Postgres)

```sql
-- users: family members (Phase F3 activates multi-user; seed one row now)
CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,            -- "framework", "macbook", "iphone"
  last_sync   TIMESTAMPTZ
);

CREATE TABLE conversations (
  id          UUID PRIMARY KEY,         -- client-generated (UUIDv7 preferred)
  user_id     UUID NOT NULL REFERENCES users(id),
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE messages (
  id            UUID PRIMARY KEY,       -- client-generated, append-only
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  role          TEXT NOT NULL,          -- user | assistant | system
  content       TEXT NOT NULL,
  model         TEXT,                   -- logical name used (fast/code/...)
  created_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE memories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  text        TEXT NOT NULL,            -- distilled fact/preference
  source_conversation UUID REFERENCES conversations(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Vectors for `memories.text` live in Qdrant, keyed by memories.id.

CREATE INDEX ON messages (conversation_id, created_at);
CREATE INDEX ON conversations (user_id, updated_at);
CREATE INDEX ON memories (user_id, updated_at);
```

**Sync contract:** messages are **append-only** (insert-only, never edited) — this makes delta sync near-conflict-free. Conversations and memories use **last-write-wins by `updated_at`**.

---

## 8. Phased Tasks

### Phase F0 — LiteLLM gateway
- [ ] Add a `litellm` service to `docker-compose.yml` mounting `gateway/litellm-config.yaml`; pass `LITELLM_MASTER_KEY` and `ANTHROPIC_API_KEY` from env.
- [ ] Confirm the four logical models resolve: `fast`, `code`, `chat-heavy`, `frontier`.
- [ ] Verify model IDs match `ollama list` exactly; fix the config if Ollama reports different tags.
- [ ] Confirm bind is tailnet/localhost only.
- **Accept:** `curl http://localhost:4000/v1/chat/completions` with the master key and `"model":"fast"` returns a completion; a forced failure of a local model falls through to `frontier`. The provided `test-endpoints.sh` passes for the Firefly rows.

### Phase F1 — Postgres + sync service
- [ ] Create the `firefly_sync` database and apply `schema.sql`. Seed one `users` row.
- [ ] Implement `POST /devices/register` → returns device + user IDs.
- [ ] Implement `POST /sync/push` (body: arrays of new messages / upserted conversations+memories since the client's cursor) and `GET /sync/pull?since=<cursor>` (returns rows with `updated_at`/`created_at` > cursor).
- [ ] Cursor = max timestamp seen; idempotent upserts keyed by client-generated UUIDs.
- [ ] Bind to tailnet interface; simple bearer-token auth (per-device token) for now.
- **Accept:** two simulated devices can push disjoint messages and each pull the other's; replaying a push is idempotent (no duplicates).

### Phase F2 — Vector store + memory distillation
- [ ] Add `qdrant` to compose; create a `memories` collection (cosine, dims match the embed model).
- [ ] Pull an embed model in Ollama (`nomic-embed-text` or `mxbai-embed-large`).
- [ ] Temporal **scheduled** workflow: for each user, gather recent conversations not yet distilled → call `chat-heavy` to extract durable facts/preferences → write rows to `memories` → embed text via Ollama → upsert vectors to Qdrant keyed by `memories.id`.
- [ ] Add `GET /memories/search?user=<id>&q=<text>&k=8` to the sync service: embed `q`, query Qdrant, return top-k memory rows (the client injects these into the system prompt).
- **Accept:** after a seeded conversation, the scheduled run produces memory rows + vectors; `/memories/search` returns relevant memories ranked by similarity.

### Phase F3 — Multi-user (activate in lockstep with app Phase 5)
- [ ] Generate a LiteLLM **virtual key per family member** via `POST /key/generate`, each with a `models` allow-list and optional `max_budget`. Kid profile: `["fast","chat-heavy"]` only — no `code`, no `frontier`.
- [ ] Add real `users` rows; scope all sync queries by `user_id`.
- [ ] Per-device token maps to a user; sync never crosses user boundaries.
- **Accept:** a kid key is rejected when requesting `frontier`; a kid device only pulls its own user's history/memories.

---

## 9. Environment (`.env.example`)

```
LITELLM_MASTER_KEY=sk-generate-a-strong-one
ANTHROPIC_API_KEY=        # for the `frontier` fallback
SYNC_DB_URL=postgres://user:pass@localhost:5432/firefly_sync
QDRANT_URL=http://localhost:6333
OLLAMA_URL=http://localhost:11434
```

---

## 10. Verification (end-to-end)

1. `test-endpoints.sh` is green for Firefly's two rows.
2. A device registers, pushes a conversation, and a second device pulls it.
3. The memory workflow runs on schedule and `/memories/search` returns results.
4. `nmap`/`curl` from **outside** the tailnet cannot reach `:4000`, `:8787`, `:11434`, or `:6333`.
