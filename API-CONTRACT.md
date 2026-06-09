# Firefly AI Hub — Client API Contract

> For the agent building the Tauri/Svelte client app. This describes the server-side
> APIs **as they are actually implemented today** on Firefly, not the aspirational plan.
> Where this doc and `PLAN-firefly-upgrade.md` disagree, this doc wins (it was written
> from the running code). Phases F0–F2 are implemented; F3 (multi-user, per-user keys)
> is not yet active, so treat the system as **single-user** for now.

---

## 1. Topology

All services run on the host `firefly` and are reachable **only over the Tailscale
mesh**. There is no public exposure and no TLS in front of them; the tailnet is the
security boundary. Use the host's tailnet hostname/IP in place of `firefly` below.

| Service | Port | Auth | Protocol |
|---|---|---|---|
| LiteLLM gateway | `4000` | `Authorization: Bearer <LITELLM_MASTER_KEY>` | OpenAI-compatible REST |
| Sync service | `8788` | `Authorization: Bearer <SYNC_API_TOKEN>` | JSON REST |

There are two other ports on the box (`11434` Ollama, `6333` Qdrant, `8787` web
tools). **The client must not talk to those directly.** Inference goes through
LiteLLM; memory search goes through the sync service.

---

## 2. LiteLLM Gateway (`:4000`) — model inference

OpenAI-compatible. Point any OpenAI SDK at `http://firefly:4000/v1` with the master
key as the API key. The client only ever references **logical model names**; the
gateway decides which hardware answers.

### Logical models

| `model` | Use for | Notes |
|---|---|---|
| `fast` | quick replies, routing, triage | falls back to `chat-heavy` on error |
| `code` | whole-file / script generation | falls back to `chat-heavy` on error |
| `chat-heavy` | general + agentic chat | primary workhorse |
| `frontier` | cloud frontier quality | **defined but NOT wired into the fallback chain yet**; only resolves if `ANTHROPIC_API_KEY` is set server-side. Do not rely on it. |

Fallback is server-side and automatic; the client does not implement retry/fallback
across models. Just send the logical name you want.

### Chat completion

```
POST http://firefly:4000/v1/chat/completions
Authorization: Bearer <LITELLM_MASTER_KEY>
Content-Type: application/json

{
  "model": "chat-heavy",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "Hello" }
  ],
  "stream": true
}
```

Response is the standard OpenAI chat-completion shape (or SSE token stream when
`stream: true`). `drop_params` is on at the gateway, so params an individual backend
doesn't support are silently ignored rather than erroring.

`GET /v1/models` lists the resolvable logical names if you want to populate a picker.

**Embeddings:** the client does **not** call an embeddings endpoint. Memory
embedding happens entirely server-side. Use the sync service's `/memories/search`
(section 3.6) instead.

---

## 3. Sync Service (`:8788`) — conversations, messages, memories

Delta-sync API backed by Postgres. Every request requires the bearer token.

### 3.0 Auth and conventions

- **Auth:** `Authorization: Bearer <SYNC_API_TOKEN>` on every route. A missing or
  wrong token returns `401 {"error":"unauthorized"}`. Today this is a **single
  shared token** for all devices (per-device tokens are a future F3 change).
- **Content type:** request and response bodies are `application/json`.
- **IDs are client-generated** UUIDs (UUIDv7 recommended so they sort by time).
  The server upserts by these IDs; it does not mint conversation/message IDs.
- **Timestamps** are ISO-8601 UTC strings with millisecond precision and a `Z`
  suffix, e.g. `2026-06-06T14:03:21.118Z`. The client supplies them on every row.
- **User scope:** the system is single-user right now. The `user_id` you get back
  from `/devices/register` is the one to stamp on rows. Pull/search default to the
  server's single user when `user` is omitted.

### 3.1 Data shapes

These are the exact field names and nullability the API uses on the wire.

```ts
// conversation — last-write-wins by updated_at
{
  id: string,            // client-generated UUID
  user_id: string,       // UUID from /devices/register
  title: string | null,
  created_at: string,    // ISO-8601 UTC
  updated_at: string     // ISO-8601 UTC; drives LWW + the sync cursor
}

// message — APPEND-ONLY (never edited or deleted)
{
  id: string,              // client-generated UUID
  conversation_id: string, // must reference an existing/pushed conversation
  role: string,            // "user" | "assistant" | "system"
  content: string,
  model: string | null,    // the logical model name used, e.g. "chat-heavy"
  created_at: string       // ISO-8601 UTC; drives the sync cursor
}

// memory — distilled server-side; client receives them, rarely writes them
{
  id: string,
  user_id: string,
  text: string,
  source_conversation: string | null,
  updated_at: string       // ISO-8601 UTC; LWW + cursor
}
```

### 3.2 `POST /devices/register`

Call once per device on first launch; persist the returned IDs.

Request:
```json
{ "name": "framework", "userId": "optional-existing-user-uuid" }
```
- `name` (required): device label, e.g. `"framework"`, `"macbook"`, `"iphone"`.
- `userId` (optional): omit it for now; the server attaches the device to its
  default (only) user.

Response `200`:
```json
{ "deviceId": "uuid", "userId": "uuid" }
```
Stamp `userId` onto every conversation/memory you create. Errors: `400
{"error":"missing name"}`.

### 3.3 `POST /sync/push`

Upload locally-created rows. All three arrays are optional; send whatever changed.

Request:
```json
{
  "conversations": [ /* ConversationRow[] */ ],
  "messages":      [ /* MessageRow[] */ ],
  "memories":      [ /* MemoryRow[] */ ]
}
```

Response `200`: `{ "ok": true }`. The whole push is one transaction.

**Conflict semantics (important for client logic):**
- **messages** are insert-only. Re-pushing a message with an existing `id` is a
  **no-op** — safe to replay. Never mutate a message after creating it; model new
  content as a new message.
- **conversations** and **memories** are **last-write-wins by `updated_at`**. An
  incoming row only overwrites the stored one if its `updated_at` is `>=` the
  stored value. Always bump `updated_at` when you change a title, etc.

Because pushes are idempotent, the client can safely re-send its outbound queue
after a crash or network failure without deduping first.

### 3.4 `GET /sync/pull`

Download everything changed since your cursor.

```
GET http://firefly:8788/sync/pull?since=<cursor>&user=<userId>
```
- `since` (optional): the `cursor` from your last successful pull. Omit it (or pass
  nothing) to get the full history from the beginning of time
  (`1970-01-01T00:00:00.000Z`).
- `user` (optional): the user UUID. Omit for the default single user.

Response `200`:
```json
{
  "conversations": [ /* ConversationRow[], updated_at > since, asc */ ],
  "messages":      [ /* MessageRow[], created_at > since, asc */ ],
  "memories":      [ /* MemoryRow[], updated_at > since, asc */ ],
  "cursor":        "2026-06-06T14:03:21.118Z"
}
```

**Cursor handling:** the returned `cursor` is the max timestamp across all rows in
this response (or your `since` value if nothing changed). Persist it and pass it as
`since` on the next pull. The comparison is strictly greater-than, so reusing the
cursor will not re-deliver the boundary rows. The cursor is a plain ISO timestamp,
opaque to you otherwise — store and echo it, don't compute on it.

### 3.5 Suggested sync loop

1. On launch, `POST /devices/register` if you have no stored `deviceId`.
2. Push the local outbound queue with `POST /sync/push` (idempotent; retry freely).
3. `GET /sync/pull?since=<saved cursor>`; merge results locally:
   - upsert conversations/memories by `id`, keeping the row with the newer
     `updated_at`;
   - insert messages by `id`, ignoring ones you already have.
4. Save the new `cursor`.
5. Repeat on an interval / on reconnect. Order within a batch is ascending by
   timestamp, so applying in array order is safe.

### 3.6 `GET /memories/search`

Semantic search over the user's distilled memories. The server embeds your query,
queries Qdrant, and returns the matching memory rows in similarity order. Use this
to fetch context to inject into a system prompt before an inference call.

```
GET http://firefly:8788/memories/search?q=<text>&user=<userId>&k=8
```
- `q` (required): natural-language query. `400 {"error":"missing q"}` if empty.
- `user` (optional): user UUID; defaults to the single user.
- `k` (optional): number of results, default `8`, clamped to `1..50`.

Response `200`:
```json
{ "memories": [ /* MemoryRow[], ordered by similarity (best first) */ ] }
```

If memory search is not configured on the server you'll get `501
{"error":"memory search not configured"}` — handle it as "no memories available"
and proceed without context.

Memories are produced by a scheduled server-side workflow that distills recent
conversations into durable facts/preferences. The client does **not** create or
embed memories; it only reads them via this endpoint and receives them via
`/sync/pull`.

---

## 4. Error responses

All errors are JSON `{"error": "<message>"}` with these statuses:

| Status | When |
|---|---|
| `400` | malformed JSON, missing required field (`name`, `q`) |
| `401` | missing/invalid bearer token |
| `404` | unknown route/method |
| `501` | `/memories/search` called but memory search not wired on server |
| `500` | server-side failure |

Treat `5xx` and network errors as retryable (the sync writes are idempotent).
Treat `400`/`401` as client bugs to surface, not retry.

---

## 5. Not yet available (do not depend on)

- **Per-user / per-device tokens and multi-user scoping (F3).** One shared
  `SYNC_API_TOKEN` and one user exist today. Design your storage so a real
  `user_id` can be threaded through later, but expect a single user for now.
- **`frontier` cloud fallback.** The model name resolves only if a cloud key is
  configured server-side, and it is not in the automatic fallback chain. Don't
  build UX that assumes a cloud tier is always reachable.
- **Per-user LiteLLM virtual keys / model allow-lists.** All clients currently use
  the single master key.

---

## 6. Quick reference

```
# Inference
POST   http://firefly:4000/v1/chat/completions     Bearer LITELLM_MASTER_KEY
GET    http://firefly:4000/v1/models               Bearer LITELLM_MASTER_KEY

# Sync (all Bearer SYNC_API_TOKEN)
POST   http://firefly:8788/devices/register        { name, userId? } -> { deviceId, userId }
POST   http://firefly:8788/sync/push               { conversations?, messages?, memories? } -> { ok: true }
GET    http://firefly:8788/sync/pull?since=&user=  -> { conversations, messages, memories, cursor }
GET    http://firefly:8788/memories/search?q=&user=&k=8  -> { memories }
```
