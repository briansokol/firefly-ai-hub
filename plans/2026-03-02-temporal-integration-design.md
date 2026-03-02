# Temporal Integration Design

**Date:** 2026-03-02
**Status:** Approved
**Supersedes:** Portions of `2026-02-28-ai-hub-architecture.md` (Layer 3 cron/scheduling, docker-compose)

---

## Decision

Adopt Temporal as the workflow orchestration layer for the AI Hub, replacing `node-cron` and adding durable execution to both scheduled jobs and Discord chat interactions. Adopted early (before cron/workflow code is written) to avoid retrofitting.

**Rationale:**
- The system is planned to grow into multi-step agentic workflows; Temporal is the right foundation
- The workflow orchestration code (cron wiring, email triage runner, daily summary) is not yet written — this is the ideal moment to adopt
- Hardware (32 GB RAM, 12-core Ryzen 5900X) comfortably supports the additional containers
- Existing code (`imap.ts`, `triage.ts`, `state.ts`, `ollama.ts`) transfers unchanged as Activities

---

## Architecture

### Deployment Model

Option A: single hub container runs the Discord bot and Temporal Worker in the same process. The Temporal Worker registers workflows and activities; the Discord bot uses a Temporal Client to start workflows.

```
docker-compose stack (4 containers):
├── ai-hub          — Discord bot + Temporal Worker (same process)
├── open-webui      — Web dashboard
├── temporal        — temporalio/auto-setup (all server services in one process)
└── postgresql      — Temporal persistence layer
```

### Updated Architecture Diagram

```
Discord API ←──(WebSocket)──→  AI Hub Service (Node.js)
                                    │
                          ┌─────────┼──────────────┐
                          │                        │
                    discord.js                Temporal Worker
                    (bot.ts)               (worker.ts + workflows.ts)
                          │                        │
                          │  starts Workflow        │  executes Activities
                          └──→ Temporal Client ─────┘
                                      │
                              Temporal Server :7233
                              PostgreSQL (persistence)
                                      │
                              Activities call:
                              ├── Ollama HTTP :11434
                              ├── IMAP (email)
                              ├── SQLite (IMAP UID state)
                              └── Discord Client (post results)
```

---

## New Files

```
hub/src/temporal/
├── worker.ts       — Worker setup; registers workflows + activities; task queue: "ai-hub"
├── workflows.ts    — chatWorkflow, emailTriageWorkflow, dailySummaryWorkflow
├── activities.ts   — thin wrappers around imap.ts, triage.ts, ollama.ts, state.ts
└── schedules.ts    — registers Temporal Schedules on startup (replaces node-cron)
```

### Removed

- `hub/src/cron/` directory (never created; daily-summary becomes a Temporal Workflow)
- `node-cron` dependency

---

## Workflows

### `chatWorkflow(model, systemPrompt, userMessage) → string`

Handles a single Discord chat interaction. The Discord bot starts this workflow via Temporal Client and awaits the result before sending the reply.

**Activities:**
1. `callOllama(model, systemPrompt, userMessage) → string`

**Retry policy:** 3 attempts, 2s initial backoff (handles transient Ollama unavailability).

---

### `emailTriageWorkflow(accountName) → void`

Processes unseen emails for one IMAP account. One workflow instance per account, triggered by Temporal Schedule at 7am America/New_York.

**Activities (sequential):**
1. `fetchEmails(account, sinceUid) → { emails, maxUid }`
2. `triageWithOllama(emails) → TriageResult`
3. `postEmailResults(results) → void`  ← posts to `#email` and `#alerts`
4. `updateLastUid(accountName, maxUid) → void`

**Retry policies:**
- `fetchEmails`: 3x, 5s backoff
- `triageWithOllama`: 3x, 2s backoff
- `postEmailResults`: 3x, 2s backoff
- `updateLastUid`: 3x, 1s backoff

---

### `dailySummaryWorkflow() → void`

Posts an AI-generated daily summary. Triggered by Temporal Schedule at 9pm America/New_York.

**Activities (sequential):**
1. `generateSummary() → string`
2. `postSummary(summary) → void`  ← posts to `#daily-summary`

**Retry policies:** 3x, 2s backoff on both.

---

## Activity → Existing Code Mapping

| Activity | Delegates to | Notes |
|---|---|---|
| `callOllama` | `ollama.ts: chat()` | Unchanged |
| `fetchEmails` | `imap.ts: fetchNewEmails()` | Unchanged |
| `triageWithOllama` | `triage.ts: buildTriagePrompt()` + `ollama.ts: chat()` | Unchanged |
| `postEmailResults` | Discord client `.send()` | New thin wrapper |
| `updateLastUid` | `state.ts: setLastUid()` | Unchanged |
| `generateSummary` | `ollama.ts: chat()` | Unchanged |
| `postSummary` | Discord client `.send()` | New thin wrapper |

Dependencies (Discord client, SQLite state store, Ollama client) are injected into activities via closure in `activities.ts` — standard Temporal pattern for runtime dependencies.

---

## Docker Compose Changes

New services added to `deploy/docker-compose.yml`:

```yaml
postgresql:
  image: postgres:16-alpine
  environment:
    POSTGRES_PASSWORD: temporal
    POSTGRES_USER: temporal
    POSTGRES_DB: temporal
  volumes:
    - temporal-db:/var/lib/postgresql/data

temporal:
  image: temporalio/auto-setup:latest
  depends_on: [postgresql]
  environment:
    DB: postgres12
    DB_PORT: 5432
    POSTGRES_USER: temporal
    POSTGRES_PWD: temporal
    POSTGRES_SEEDS: postgresql
  ports:
    - "127.0.0.1:7233:7233"   # gRPC — Worker + Client connect here
    - "127.0.0.1:8080:8080"   # Temporal Web UI
  extra_hosts:
    - "host.docker.internal:host-gateway"
```

New environment variable on `ai-hub` service:
```yaml
environment:
  - TEMPORAL_ADDRESS=temporal:7233
```

New volume:
```yaml
volumes:
  temporal-db:
  hub-state:    # existing
  open-webui:   # existing
```

---

## State Management

SQLite (`state.ts`) is retained as-is for IMAP UID tracking. Activities read/write `state.db` directly. Temporal does not manage this state — it is an implementation detail of the `fetchEmails` / `updateLastUid` activities.

---

## Discord Bot Change (`bot.ts`)

Before:
```typescript
const reply = await chat(ollamaClient, model, systemPrompt, content);
```

After:
```typescript
const reply = await temporalClient.workflow.execute(chatWorkflow, {
  args: [model, systemPrompt, content],
  taskQueue: 'ai-hub',
  workflowId: `chat-${message.id}`,
});
```

All other bot logic (allowlist, routing, mention stripping, response splitting) is unchanged.

---

## `index.ts` Changes

Removes `node-cron` scheduling. Adds:
1. Start Temporal Worker (registers workflows + activities)
2. Register Temporal Schedules for email triage and daily summary

Graceful shutdown: `worker.shutdown()` added to SIGTERM handler alongside `stateStore.close()` and `discordClient.destroy()`.

---

## Open Questions

| Question | Notes |
|---|---|
| Retry policy tuning | Defaults are conservative; adjust based on real usage in Phase 6 |
| Temporal Web UI exposure | Currently localhost-only (:8080); expose via Tailscale if desired |
| Future agentic workflows | Temporal Schedules + Workflows are the natural extension point |
