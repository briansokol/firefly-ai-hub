# Firefly AI Hub — Client API Contract

> For the agent building the Tauri/Svelte client app. This describes the server-side
> APIs **as they are actually implemented today** on Firefly, not the aspirational plan.
> Where this doc and `PLAN-firefly-upgrade.md` disagree, this doc wins (it was written
> from the running code). Phases F0–F3 are implemented: the system is **multi-user**,
> with per-device sync tokens and per-user LiteLLM virtual keys (see section 0). A
> later change replaced device self-registration with **username/password account
> login** (`POST /auth/signup` + `POST /auth/login`) and a device-management API;
> `POST /devices/register` has been **removed** — see §0.3.

---

## 0. What changed in F3 (read this if you built against the pre-F3 contract)

The system is now **multi-user**. Summary of endpoint/auth changes:

| Endpoint | Status | Change |
|---|---|---|
| All sync routes | **CHANGED auth** | Was one shared `SYNC_API_TOKEN`. Now each device sends its **own device token** (issued at provisioning). The token determines the user. |
| `POST /devices/register` | **REMOVED** | Was the device-registration endpoint (admin-only in F3, then open self-registration). _Removed entirely — accounts use `POST /auth/signup` + `POST /devices`; see §0.3._ |
| `GET /sync/pull` | **CHANGED** | The `?user=` param is **ignored** for device tokens (a device always returns its own user's rows). Only the admin token may target another user via `?user=`. |
| `GET /memories/search` | **CHANGED** | Same `?user=` change as pull — ignored for device tokens. |
| `POST /sync/push` | **CHANGED** | Rows whose `user_id` is not the device's user are rejected with `403 {"error":"scope violation"}`. |
| LiteLLM `:4000` | **CHANGED** | The app uses a **per-user virtual key** (from provisioning), not the master key. Keys are model-scoped: `adult` = `fast/code/chat-heavy/frontier`; `kid` = `fast/chat-heavy`. Requesting a disallowed model returns a 4xx. |
| `403` status | **NEW** | Returned for scope violations (in F3, also for using a device token on the then-admin-only register route; post-F3 that route is open — see §0.1). |

---

## 0.1 What changed after F3 (open self-registration)

> **SUPERSEDED by §0.3.** Open self-registration via `POST /devices/register` has
> been **removed**. Accounts are now created with `POST /auth/signup` and devices are
> added with the authenticated device-management API. This section is kept only to
> explain the migration path; do not build against `POST /devices/register`.

This describes the (now-removed) open-registration behavior. If you built against the
admin-only F3 register endpoint, here was the delta:

| Area | Was (F3) | Now (current) |
|---|---|---|
| `POST /devices/register` auth | **Admin-only** — required `Authorization: Bearer <SYNC_API_TOKEN>`. | **Open** — no token required (the tailnet is the trust boundary). |
| Register body | `{ name, userId }` only (attach to an existing user). | Two modes: `{ name, userId }` (existing user) **or** `{ name, displayName }` (create a new user). |
| Register response | `{ deviceId, userId, deviceToken }`. | Adds `litellmKey` and `profile`: `{ deviceId, userId, deviceToken, litellmKey, profile }`. A self-registering device now obtains its LiteLLM key from this call instead of out-of-band. |
| New-user profile | n/a (users were created by the operator CLI). | New signups are **always `kid`** by default. Creating an `adult` user via register requires the admin token (`403` otherwise). |
| Profile lifetime | Fixed at user creation. | **Per-user attribute** an operator can change later (kid↔adult) with the `user-set-profile` CLI; it re-scopes the user's existing LiteLLM key **in place** (same key string), so the client's allowed model set can widen/narrow between sessions without the key changing. |

**Client impact:**
- Onboarding no longer needs an out-of-band admin step: a fresh device can `POST
  /devices/register` with `{ name, displayName }` and receive its `deviceToken` +
  `litellmKey` directly. It will be a `kid`-profile user; an operator promotes it to
  `adult` server-side if needed.
- Because a user's profile (and therefore its key's model allow-list) can change
  server-side without the key string changing, don't hard-cache the model list
  forever — re-fetch `GET /v1/models` periodically (and treat a `4xx` for a
  previously-allowed model as "your profile changed," not a bug).

---

## 0.2 What changed after F3 (conversation rename + delete)

Renaming a conversation was always possible (it is just an LWW `title` write); this
makes it explicit and adds conversation **deletion**. Both ride the existing
`POST /sync/push` + `GET /sync/pull` — no new endpoints.

| Area | Was | Now (current) |
|---|---|---|
| Conversation shape | `{ id, user_id, title, created_at, updated_at }`. | Adds `deleted_at: string \| null` — a soft-delete tombstone. |
| Deleting a conversation | Not supported (a hard delete never reaches other devices). | Set `deleted_at` + bump `updated_at` and push; the tombstone propagates via pull under LWW (see §3.7). |
| Renaming a conversation | Worked but undocumented. | Documented: set `title` + bump `updated_at` and push (§3.7). |
| Memory distillation | Distilled all synced conversations. | Skips soft-deleted conversations; memories distilled before a delete are retained. |

**Client impact:**
- Pull responses now include `deleted_at` on every conversation row (`null` for
  active ones). Merge a non-null `deleted_at` as "hide this conversation locally."
- To delete, don't drop the row — push it with `deleted_at` set so other devices
  converge.

---

## 0.3 What changed after F3 (account login + device management)

This **removes** open device self-registration and replaces it with real accounts.
A user now creates an account with a **username + password**, logs in to obtain a
short-lived **session token**, and uses that token (or any of the user's device
tokens) to list / register / claim / remove devices.

| Area | Was (open self-registration) | Now (current) |
|---|---|---|
| Account creation | `POST /devices/register` with `{ name, displayName }`. | `POST /auth/signup` with `{ username, password, displayName, profile? }` (§3.2). |
| Logging in on a device | n/a (paste a raw user UUID into `POST /devices/register`). | `POST /auth/login` with `{ username, password }` → session token + the user's device list (§3.2). |
| Adding a device | `POST /devices/register` (open, no token). | `POST /devices` with a session **or** device token (§3.2). |
| Reusing an existing device entry | n/a. | `POST /devices/:id/claim` rotates that device's token to the caller (§3.2). |
| Listing / removing devices | n/a. | `GET /devices` / `DELETE /devices/:id` (§3.2). |
| `POST /devices/register` | The onboarding endpoint. | **Removed.** Authenticated requests to it return `404`; unauthenticated ones `401`. |
| Credential kinds | admin token + device token. | admin token + device token + **session token** (short-lived; see §3.0). |

**Client impact:**
- Onboarding is now two calls: `POST /auth/signup` (create the account, returns a
  `sessionToken` + `litellmKey`) then `POST /devices` (register this device, returns
  its durable `deviceToken`). A returning user calls `POST /auth/login` instead of
  signup, then either `POST /devices` (new device) or `POST /devices/:id/claim`
  (reuse an existing entry, e.g. after a reinstall).
- The `sessionToken` is short-lived (~30 days); the `deviceToken` is the durable
  credential for all `/sync/*` routes. Persist both; re-login when the session
  expires (a `401` on a device-management call with a session token = expired).
- Profile rules are unchanged: signups are `kid` by default; creating an `adult`
  user requires the admin token (`SYNC_API_TOKEN`).

---

## 1. Topology

All services run on the host `firefly` and are reachable **only over the Tailscale
mesh**. There is no public exposure and no TLS in front of them; the tailnet is the
security boundary. Use the host's tailnet hostname/IP in place of `firefly` below.

| Service | Port | Auth | Protocol |
|---|---|---|---|
| LiteLLM gateway | `4000` | `Authorization: Bearer <per-user virtual key>` | OpenAI-compatible REST |
| Sync service | `8788` | `Authorization: Bearer <device or session token>`; `/auth/signup` + `/auth/login` need no token (admin token only to create an `adult` user or to target another user via `?user=`) | JSON REST |

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
Authorization: Bearer <per-user virtual key>
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

- **Auth:** `Authorization: Bearer <token>` on every route except `/auth/signup`
  and `/auth/login` (which need **no** token). There are three credential kinds, all
  resolved from the same bearer header:
  - **device token** — issued when a device is registered; durable; the credential
    for all `/sync/*` routes. The token alone determines the user.
  - **session token** — minted by `/auth/signup` + `/auth/login`; short-lived
    (~30 days); used to authorize the device-management routes (`GET/POST /devices`,
    `POST /devices/:id/claim`, `DELETE /devices/:id`). Device tokens also work on
    those routes. A missing or unknown/expired token returns
    `401 {"error":"unauthorized"}`.
  - **admin token** (`SYNC_API_TOKEN`) — operator/provisioning-only: it may target
    any user via `?user=` and is required to create an `adult` user via signup. App
    clients never use the admin token.
- **Content type:** request and response bodies are `application/json`.
- **IDs are client-generated** UUIDs (UUIDv7 recommended so they sort by time).
  The server upserts by these IDs; it does not mint conversation/message IDs.
- **Timestamps** are ISO-8601 UTC strings with millisecond precision and a `Z`
  suffix, e.g. `2026-06-06T14:03:21.118Z`. The client supplies them on every row.
- **User scope:** the system is multi-user. Your device/session token is bound to
  exactly one user; stamp that `user_id` (returned by signup/login) on every row you
  create. `pull` and `memories/search` always return your own user's data — the
  `?user=` param is ignored for device and session tokens (admin only). Pushing rows
  for another user returns `403`.

### 3.1 Data shapes

These are the exact field names and nullability the API uses on the wire.

```ts
// conversation — last-write-wins by updated_at
{
  id: string,            // client-generated UUID
  user_id: string,       // UUID from /auth/signup or /auth/login
  title: string | null,
  created_at: string,    // ISO-8601 UTC
  updated_at: string,    // ISO-8601 UTC; drives LWW + the sync cursor
  deleted_at: string | null  // ISO-8601 UTC tombstone; non-null = deleted
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

### 3.2 Account login + device management

`POST /devices/register` has been **removed**. Accounts are created and devices
managed through the endpoints below. Onboarding is: `POST /auth/signup` (or
`/auth/login` for a returning user) to get a `sessionToken`, then `POST /devices` to
register this device and obtain its durable `deviceToken`.

#### `POST /auth/signup` (no token; admin token only for an `adult` user)

Creates a user, mints its per-user LiteLLM key, and returns a session token.
```json
{ "username": "kiddo", "password": "at-least-8-chars", "displayName": "Kiddo" }
```
- `username` (required): login id. Trimmed + lowercased; must match
  `^[a-z0-9_.-]{3,32}$`. Invalid form → `400 {"error":"invalid username"}`. Already
  taken → `409 {"error":"username taken"}`.
- `password` (required): 8–256 chars. Out of range → `400 {"error":"invalid password"}`.
- `displayName` (required): the user's display name. Missing → `400 {"error":"missing displayName"}`.
- `profile` (optional): the user's profile (model allow-list: `adult` =
  `fast/code/chat-heavy/frontier`; `kid` = `fast/chat-heavy`). **Defaults to `kid`**;
  any other value requires `Authorization: Bearer <SYNC_API_TOKEN>`, else
  `403 {"error":"admin token required for non-kid profile"}`. Unknown value →
  `400 {"error":"invalid profile"}`.

Response `200`:
```json
{ "userId": "uuid", "username": "kiddo", "displayName": "Kiddo", "profile": "kid",
  "litellmKey": "<per-user LiteLLM key>", "sessionToken": "<bearer, shown once>",
  "sessionExpiresAt": "2026-07-12T14:03:21.118Z" }
```
Signup returns **no** device token — call `POST /devices` next. Persist `litellmKey`
(the API key for `:4000`) and stamp `userId` on every row you create.

#### `POST /auth/login` (no token)

Verifies credentials and returns a fresh session token plus the user's devices.
```json
{ "username": "kiddo", "password": "at-least-8-chars" }
```
Response `200`:
```json
{ "userId": "uuid", "username": "kiddo", "profile": "kid",
  "litellmKey": "<per-user LiteLLM key>", "sessionToken": "<bearer, shown once>",
  "sessionExpiresAt": "2026-07-12T14:03:21.118Z",
  "devices": [ { "id": "uuid", "name": "macbook", "lastSync": "...Z|null" } ] }
```
Bad credentials, unknown username, or a user without a password all return the same
`401 {"error":"invalid credentials"}` (no account enumeration). Missing fields →
`400 {"error":"missing username"}` / `{"error":"missing password"}`.

#### `GET /devices` (session **or** device token)

Lists the authenticated user's devices.
```json
{ "devices": [ { "id": "uuid", "name": "macbook", "lastSync": "...Z|null" } ] }
```

#### `POST /devices` (session **or** device token)

Registers a new device for the authenticated user.
```json
{ "name": "macbook" }
```
- `name` (required): device label. Missing → `400 {"error":"missing name"}`.

Response `200`:
```json
{ "deviceId": "uuid", "userId": "uuid", "deviceToken": "<bearer, shown once>", "litellmKey": "<per-user LiteLLM key>" }
```
Persist `deviceToken` — it is the durable credential for all `/sync/*` routes.

#### `POST /devices/:id/claim` (session **or** device token)

Rotates an existing device entry's token to the caller (e.g. after a reinstall, to
reuse a slot rather than create a duplicate). The old token stops working.
Response `200` is the same shape as `POST /devices`. A device id that does not exist
or belongs to another user → `404 {"error":"unknown device"}`.

#### `DELETE /devices/:id` (session **or** device token)

Removes a device from the account (revokes its token). Response `200 {"ok": true}`.
Not owned / unknown → `404 {"error":"unknown device"}`.

The operator CLI (`user-add` / `device-add`) remains available for server-side
provisioning; `user-add --username` (with a `PROVISION_PASSWORD` env var) creates a
login-capable user.

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
- **deleting a conversation** is a normal LWW conversation write: set `deleted_at`
  to the current ISO timestamp and bump `updated_at`, then push it. The tombstone
  propagates to your other devices on their next pull; merge it by marking the
  conversation deleted locally (and dropping its messages from your UI). A stale
  write with an older `updated_at` will not resurrect a deleted conversation.
  Messages remain append-only and are not deleted server-side; memories already
  distilled from a deleted conversation are retained.

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

1. On first launch, onboard: `POST /auth/signup` (or `/auth/login` for a returning
   user) to get a `sessionToken`, then `POST /devices` to obtain this device's
   `deviceToken`. Persist the `deviceToken` and `litellmKey`; subsequent launches
   reuse the stored `deviceToken`.
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

### 3.7 Renaming and deleting conversations

Both are ordinary conversation writes pushed through `POST /sync/push` — there is no
separate endpoint.

- **Rename:** set the new `title`, bump `updated_at`, push the conversation row. The
  new title syncs to your other devices on their next pull (LWW by `updated_at`).
- **Delete:** set `deleted_at` to the current ISO timestamp, bump `updated_at`, push
  the conversation row. Treat it as a tombstone — keep the row, do not try to hard
  delete. Other devices receive the tombstone via `/sync/pull` and should hide the
  conversation. Memories already distilled from it stay; if it is deleted before the
  distillation workflow runs, its messages are skipped and never become memories.

---

## 4. Error responses

All errors are JSON `{"error": "<message>"}` with these statuses:

| Status | When |
|---|---|
| `400` | malformed JSON, missing/invalid required field (`username`, `password`, `displayName`, `name`, `q`), or unknown `profile` on signup |
| `401` | missing/invalid/expired bearer token; `{"error":"invalid credentials"}` on `/auth/login` |
| `403` | scope violation (pushing another user's rows), or creating a non-`kid` user via signup without the admin token |
| `404` | unknown route/method, or an unknown/foreign device on `/devices/:id/claim` and `DELETE /devices/:id` (`{"error":"unknown device"}`) |
| `409` | `{"error":"username taken"}` on `/auth/signup` |
| `501` | `/memories/search` called but memory search not wired on server |
| `500` | server-side failure |

Treat `5xx` and network errors as retryable (the sync writes are idempotent).
Treat `400`/`403`/`404`/`409` as client bugs to surface, not retry. A `401` on a
device-management call made with a session token means the session expired — prompt
the user to log in again.

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

# Account (no token; admin token only to create an adult user)
POST   http://firefly:8788/auth/signup             { username, password, displayName, profile? } -> { userId, username, displayName, profile, litellmKey, sessionToken, sessionExpiresAt }
POST   http://firefly:8788/auth/login              { username, password }                        -> { userId, username, profile, litellmKey, sessionToken, sessionExpiresAt, devices }
#      (adult user: add  Authorization: Bearer <SYNC_API_TOKEN>  and  "profile":"adult")

# Devices (Bearer = session token from login/signup, or a device token)
GET    http://firefly:8788/devices                 -> { devices: [ { id, name, lastSync } ] }
POST   http://firefly:8788/devices                 { name } -> { deviceId, userId, deviceToken, litellmKey }
POST   http://firefly:8788/devices/<id>/claim      -> { deviceId, userId, deviceToken, litellmKey }   # rotate token to this device
DELETE http://firefly:8788/devices/<id>            -> { ok: true }

# Sync (Bearer = the device token)
POST   http://firefly:8788/sync/push               { conversations?, messages?, memories? } -> { ok: true }
GET    http://firefly:8788/sync/pull?since=         -> { conversations, messages, memories, cursor }
GET    http://firefly:8788/memories/search?q=&k=8   -> { memories }
```
