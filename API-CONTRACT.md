# Firefly AI Hub — Client API Contract

> For the agent building the Tauri/Svelte client app. This describes the server-side
> APIs **as they are actually implemented today** on Firefly, not the aspirational plan.
> Where this doc and `PLAN-firefly-upgrade.md` disagree, this doc wins (it was written
> from the running code). Phases F0–F3 are implemented: the system is **multi-user**,
> with per-device sync tokens and per-user LiteLLM virtual keys (see section 0).

---

## 0. What changed in F3 (read this if you built against the pre-F3 contract)

The system is now **multi-user**. Summary of endpoint/auth changes:

| Endpoint | Status | Change |
|---|---|---|
| All sync routes | **CHANGED auth** | Was one shared `SYNC_API_TOKEN`. Now each device sends its **own device token** (issued at provisioning). The token determines the user. |
| `POST /devices/register` | **CHANGED** | Now **admin-only** (requires `SYNC_API_TOKEN`, not a device token). `userId` is now **required**. Response now includes `deviceToken`. Normal onboarding is the server CLI, not this endpoint. |
| `GET /sync/pull` | **CHANGED** | The `?user=` param is **ignored** for device tokens (a device always returns its own user's rows). Only the admin token may target another user via `?user=`. |
| `GET /memories/search` | **CHANGED** | Same `?user=` change as pull — ignored for device tokens. |
| `POST /sync/push` | **CHANGED** | Rows whose `user_id` is not the device's user are rejected with `403 {"error":"scope violation"}`. |
| LiteLLM `:4000` | **CHANGED** | The app uses a **per-user virtual key** (from provisioning), not the master key. Keys are model-scoped: `adult` = `fast/code/chat-heavy/frontier`; `kid` = `fast/chat-heavy`. Requesting a disallowed model returns a 4xx. |
| `403` status | **NEW** | Returned for scope violations and for using a device token on an admin-only route. |

---

## 1. Topology

All services run on the host `firefly` and are reachable **only over the Tailscale
mesh**. There is no public exposure and no TLS in front of them; the tailnet is the
security boundary. Use the host's tailnet hostname/IP in place of `firefly` below.

| Service | Port | Auth | Protocol |
|---|---|---|---|
| LiteLLM gateway | `4000` | `Authorization: Bearer <per-user virtual key>` | OpenAI-compatible REST |
| Sync service | `8788` | `Authorization: Bearer <device token>` (admin token for provisioning only) | JSON REST |

There are two other ports on the box (`11434` Ollama, `6333` Qdrant, `8787` web
tools). **The client must not talk to those directly.** Inference goes through
LiteLLM; memory search goes through the sync service.

---

## 2. LiteLLM Gateway (`:4000`) — model inference

OpenAI-compatible. Point any OpenAI SDK at `http://firefly:4000/v1` with the user's
**per-user virtual key** as the API key (issued by provisioning, not the master key).
The client only ever references **logical model names**; the gateway decides which
hardware answers. Each key is scoped to its profile's allow-list: `adult` may use
`fast/code/chat-heavy/frontier`; `kid` may use only `fast/chat-heavy`. Requesting a
model outside the allow-list returns a 4xx — surface it rather than retrying.

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

- **Auth:** `Authorization: Bearer <device token>` on every route. Each device has
  its own token, issued at provisioning; the token alone determines the user. A
  missing or unknown token returns `401 {"error":"unauthorized"}`. The admin token
  (`SYNC_API_TOKEN`) is operator/provisioning-only: it gates `/devices/register` and
  may target any user via `?user=`. App clients never use the admin token.
- **Content type:** request and response bodies are `application/json`.
- **IDs are client-generated** UUIDs (UUIDv7 recommended so they sort by time).
  The server upserts by these IDs; it does not mint conversation/message IDs.
- **Timestamps** are ISO-8601 UTC strings with millisecond precision and a `Z`
  suffix, e.g. `2026-06-06T14:03:21.118Z`. The client supplies them on every row.
- **User scope:** the system is multi-user. Your device token is bound to exactly
  one user; stamp that `user_id` (provided at provisioning) on every row you create.
  `pull` and `memories/search` always return your own user's data — the `?user=`
  param is ignored for device tokens. Pushing rows for another user returns `403`.

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

### 3.2 `POST /devices/register` (admin-only)

**The normal onboarding path is the server-side provisioning CLI**, not this
endpoint. The operator runs `user-add` (creates the user + its LiteLLM virtual key)
then `device-add` (mints the device token), and configures the app with the returned
**device token** and **LiteLLM key** out-of-band. This endpoint exists for
programmatic provisioning and requires the **admin token** (`SYNC_API_TOKEN`).

Request (admin token):
```json
{ "name": "framework", "userId": "existing-user-uuid" }
```
- `name` (required): device label, e.g. `"framework"`, `"macbook"`, `"iphone"`.
- `userId` (**required**): the user this device belongs to.

Response `200`:
```json
{ "deviceId": "uuid", "userId": "uuid", "deviceToken": "<bearer token, shown once>" }
```
Persist `deviceToken` (it is the device's bearer token going forward) and stamp
`userId` onto every conversation/memory you create. Errors: `400
{"error":"missing name"}` / `{"error":"missing userId"}`; `403` if called without the
admin token.

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
GET http://firefly:8788/sync/pull?since=<cursor>
```
- `since` (optional): the `cursor` from your last successful pull. Omit it (or pass
  nothing) to get the full history from the beginning of time
  (`1970-01-01T00:00:00.000Z`).
- The returned rows are always your own user's (determined by your device token); a
  `?user=` param is ignored for device tokens.

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
GET http://firefly:8788/memories/search?q=<text>&k=8
```
- `q` (required): natural-language query. `400 {"error":"missing q"}` if empty.
- `k` (optional): number of results, default `8`, clamped to `1..50`.
- Results are scoped to your own user (from your device token); `?user=` is ignored.

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
| `403` | scope violation (pushing another user's rows) or using a device token on an admin-only route |
| `404` | unknown route/method |
| `501` | `/memories/search` called but memory search not wired on server |
| `500` | server-side failure |

Treat `5xx` and network errors as retryable (the sync writes are idempotent).
Treat `400`/`401`/`403` as client bugs to surface, not retry.

---

## 5. Not yet available (do not depend on)

- **`frontier` cloud fallback.** The model name resolves only if a cloud key is
  configured server-side, and it is not in the automatic fallback chain. Don't
  build UX that assumes a cloud tier is always reachable. Note that only `adult`
  keys are allowed to request `frontier` at all.

---

## 6. Quick reference

```
# Inference (Bearer = the user's per-user virtual key)
POST   http://firefly:4000/v1/chat/completions     Bearer <per-user virtual key>
GET    http://firefly:4000/v1/models               Bearer <per-user virtual key>

# Sync (Bearer = the device token; admin token only for /devices/register)
POST   http://firefly:8788/devices/register        (admin) { name, userId } -> { deviceId, userId, deviceToken }
POST   http://firefly:8788/sync/push               { conversations?, messages?, memories? } -> { ok: true }
GET    http://firefly:8788/sync/pull?since=         -> { conversations, messages, memories, cursor }
GET    http://firefly:8788/memories/search?q=&k=8   -> { memories }
```
