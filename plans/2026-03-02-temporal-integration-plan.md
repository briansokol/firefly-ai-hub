# Temporal Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `node-cron` with Temporal for workflow orchestration, routing both scheduled jobs (email triage, daily summary) and Discord chat interactions through Temporal Workflows and Activities.

**Architecture:** A single Temporal Worker runs inside the hub container alongside the Discord bot. Existing code (`imap.ts`, `triage.ts`, `state.ts`, `ollama.ts`) becomes Activity implementations with no changes. New files in `hub/src/temporal/` handle the Temporal layer. `bot.ts` gets a small update to start a `chatWorkflow` instead of calling `chat()` directly.

**Tech Stack:** `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, `@temporalio/activity` — TypeScript ESM, task queue `ai-hub`, Temporal server via `temporalio/auto-setup` Docker image + PostgreSQL.

**Design doc:** `plans/2026-03-02-temporal-integration-design.md`

---

## Key Temporal Concepts

Before implementing, understand these constraints:

1. **Workflow code is deterministic.** `workflows.ts` runs in a V8 isolate. It may only import from `@temporalio/workflow`. No Node.js built-ins, no I/O, no `Date.now()`, no `Math.random()`.

2. **Activities do all the work.** All Node.js I/O lives in `activities.ts`. Activities are plain async functions — no Temporal-specific imports needed in their bodies.

3. **`proxyActivities` creates typed stubs.** Calling the proxies inside a workflow routes through Temporal's scheduling + retry system. Calling them outside a workflow context errors — so never call activity proxies from non-workflow code.

4. **Don't import workflow functions into client code.** `bot.ts` must not import from `workflows.ts` — that would execute `proxyActivities` in Node.js context. Use string workflow type names with types from `workflow-types.ts` instead.

5. **Worker bundles workflows separately.** `workflowsPath` tells the Worker where to find the compiled workflow file; it bundles it with webpack into a self-contained isolate. Only import `@temporalio/workflow` from within workflow files.

---

## Task 1: Install / Remove Dependencies

**Files:**
- Modify: `hub/package.json`

**Step 1: Install Temporal SDK packages**

```bash
cd hub
npm install @temporalio/client @temporalio/worker @temporalio/workflow @temporalio/activity
```

Expected: packages added to `dependencies` in `package.json`.

**Step 2: Remove node-cron**

```bash
npm uninstall node-cron @types/node-cron
```

Expected: `node-cron` and `@types/node-cron` removed from `package.json`.

**Step 3: Verify build still passes**

```bash
npm run build
```

Expected: no errors (existing code doesn't use node-cron yet — the cron wiring task was never completed).

**Step 4: Commit**

```bash
cd ..
git add hub/package.json hub/package-lock.json
git commit -m "feat(hub): add Temporal SDK, remove node-cron"
```

---

## Task 2: Write `workflow-types.ts`

This file declares workflow function signatures for use in client code (`bot.ts`, `schedules.ts`) without importing from `@temporalio/workflow`. No Temporal imports allowed here.

**Files:**
- Create: `hub/src/temporal/workflow-types.ts`

**Step 1: Write the file**

```typescript
// hub/src/temporal/workflow-types.ts
// Workflow type signatures — safe to import from non-workflow code.
// Do NOT import @temporalio/workflow here.

export type ChatWorkflow = (
  model: string,
  systemPrompt: string,
  userMessage: string,
) => Promise<string>;

export type EmailTriageWorkflow = (accountName: string) => Promise<void>;

export type DailySummaryWorkflow = () => Promise<void>;
```

**Step 2: Verify build**

```bash
cd hub && npm run build
```

Expected: no errors.

**Step 3: Commit**

```bash
cd ..
git add hub/src/temporal/workflow-types.ts
git commit -m "feat(hub): add Temporal workflow type definitions"
```

---

## Task 3: Write `activities.ts`

All Activity implementations. Thin wrappers that delegate to existing code. The `createActivities` factory pattern injects runtime dependencies (Ollama client, Discord client, config, state store) via closure — the standard Temporal pattern for stateful activities.

**Files:**
- Create: `hub/src/temporal/activities.ts`

**Step 1: Write the file**

```typescript
// hub/src/temporal/activities.ts
import type OpenAI from 'openai';
import type { Client as DiscordClient } from 'discord.js';
import type { Config } from '../types.js';
import type { StateStore } from '../email/state.js';
import type { FetchedEmail } from '../email/imap.js';
import { chat } from '../ollama.js';
import { fetchNewEmails } from '../email/imap.js';
import { buildTriagePrompt, parseTriageResponse } from '../email/triage.js';
import { getEmailPassword } from '../config.js';

export interface ActivityDeps {
  ollamaClient: OpenAI;
  discordClient: DiscordClient;
  config: Config;
  stateStore: StateStore;
}

export function createActivities(deps: ActivityDeps) {
  const { ollamaClient, discordClient, config, stateStore } = deps;

  function getTextChannel(name: string) {
    const guild = discordClient.guilds.cache.get(config.discord.guild_id);
    const channel = guild?.channels.cache.find((c) => c.name === name);
    return channel?.isTextBased() ? channel : null;
  }

  return {
    async callOllama(
      model: string,
      systemPrompt: string,
      userMessage: string,
    ): Promise<string> {
      return chat(ollamaClient, model, systemPrompt, userMessage);
    },

    async getLastUid(accountName: string): Promise<number> {
      return stateStore.getLastUid(accountName);
    },

    async fetchEmails(
      accountName: string,
      sinceUid: number,
    ): Promise<{ emails: FetchedEmail[]; maxUid: number }> {
      const account = config.email.accounts.find((a) => a.name === accountName);
      if (!account) throw new Error(`Unknown email account: ${accountName}`);
      const password = getEmailPassword(account);
      const emails = await fetchNewEmails(account, password, sinceUid);
      const maxUid = emails.length > 0 ? Math.max(...emails.map((e) => e.uid)) : sinceUid;
      return { emails, maxUid };
    },

    async triageWithOllama(email: FetchedEmail): Promise<{ summary: string; actionItems: string[]; urgent: boolean }> {
      const { system, user } = buildTriagePrompt(email);
      const raw = await chat(ollamaClient, config.models.default, system, user);
      return parseTriageResponse(raw);
    },

    async postEmailResult(
      accountName: string,
      subject: string,
      summary: string,
      urgent: boolean,
      actionItems: string[],
    ): Promise<void> {
      const emailChannel = getTextChannel('email');
      if (emailChannel) {
        await emailChannel.send(`📧 **${accountName}** | **${subject}**\n${summary}`);
      }
      if (urgent && actionItems.length > 0) {
        const alertsChannel = getTextChannel('alerts');
        if (alertsChannel) {
          const items = actionItems.map((item) => `• ${item}`).join('\n');
          await alertsChannel.send(`⚠️ **Action required** — ${subject}\n${items}`);
        }
      }
    },

    async updateLastUid(accountName: string, uid: number): Promise<void> {
      stateStore.setLastUid(accountName, uid);
    },

    async generateDailySummary(): Promise<string> {
      const today = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });
      const system =
        'You are a friendly personal assistant. Write warm, concise daily summaries.';
      const user = `Write a brief daily summary for ${today}. 2-3 sentences.`;
      return chat(ollamaClient, config.models.default, system, user);
    },

    async postDailySummary(summary: string): Promise<void> {
      const channel = getTextChannel('daily-summary');
      if (channel) {
        await channel.send(`📅 **Daily Summary**\n${summary}`);
      }
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
```

**Step 2: Verify build**

```bash
cd hub && npm run build
```

Expected: no errors.

**Step 3: Run existing tests to confirm nothing is broken**

```bash
npm test
```

Expected: all existing tests pass (config, router, state, triage tests are unaffected).

**Step 4: Commit**

```bash
cd ..
git add hub/src/temporal/activities.ts
git commit -m "feat(hub): add Temporal activity definitions"
```

---

## Task 4: Write `workflows.ts`

Workflow orchestration logic. **This file may only import from `@temporalio/workflow`.** All I/O is delegated to activities via `proxyActivities`. The `proxyActivities` call configures the default retry policy for all activities.

**Files:**
- Create: `hub/src/temporal/workflows.ts`

**Step 1: Write the file**

```typescript
// hub/src/temporal/workflows.ts
// IMPORTANT: Only import from @temporalio/workflow. No Node.js built-ins.
// No imports from activities.ts or any code with I/O.
import { proxyActivities } from '@temporalio/workflow';
import type { Activities } from './activities.js';

const {
  callOllama,
  getLastUid,
  fetchEmails,
  triageWithOllama,
  postEmailResult,
  updateLastUid,
  generateDailySummary,
  postDailySummary,
} = proxyActivities<Activities>({
  startToCloseTimeout: '5 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '2s',
    backoffCoefficient: 2,
  },
});

export async function chatWorkflow(
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  return callOllama(model, systemPrompt, userMessage);
}

export async function emailTriageWorkflow(accountName: string): Promise<void> {
  const sinceUid = await getLastUid(accountName);
  const { emails, maxUid } = await fetchEmails(accountName, sinceUid);
  if (emails.length === 0) return;

  for (const email of emails) {
    const result = await triageWithOllama(email);
    await postEmailResult(
      accountName,
      email.subject,
      result.summary,
      result.urgent,
      result.actionItems,
    );
  }

  await updateLastUid(accountName, maxUid);
}

export async function dailySummaryWorkflow(): Promise<void> {
  const summary = await generateDailySummary();
  await postDailySummary(summary);
}
```

**Step 2: Verify build**

```bash
cd hub && npm run build
```

Expected: no errors.

**Step 3: Commit**

```bash
cd ..
git add hub/src/temporal/workflows.ts
git commit -m "feat(hub): add Temporal workflow definitions"
```

---

## Task 5: Write `worker.ts`

Creates and configures the Temporal Worker. Uses `NativeConnection` for the gRPC connection. The `workflowsPath` must point to the **compiled** JS file — `import.meta.url` resolves correctly from `dist/temporal/worker.js` at runtime.

**Files:**
- Create: `hub/src/temporal/worker.ts`

**Step 1: Write the file**

```typescript
// hub/src/temporal/worker.ts
import { Worker, NativeConnection } from '@temporalio/worker';
import { createActivities } from './activities.js';
import type { ActivityDeps } from './activities.js';

export async function createWorker(deps: ActivityDeps): Promise<Worker> {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const connection = await NativeConnection.connect({ address });

  return Worker.create({
    connection,
    namespace: 'default',
    taskQueue: 'ai-hub',
    // Points to compiled dist/temporal/workflows.js at runtime
    workflowsPath: new URL('./workflows.js', import.meta.url).pathname,
    activities: createActivities(deps),
  });
}
```

**Step 2: Verify build**

```bash
cd hub && npm run build
```

Expected: no errors.

**Step 3: Commit**

```bash
cd ..
git add hub/src/temporal/worker.ts
git commit -m "feat(hub): add Temporal worker setup"
```

---

## Task 6: Write `schedules.ts`

Registers Temporal Schedules on startup — one per email account plus one for daily summary. Uses `getHandle().describe()` to check existence before creating, making registration idempotent across restarts.

**Files:**
- Create: `hub/src/temporal/schedules.ts`

**Step 1: Write the file**

```typescript
// hub/src/temporal/schedules.ts
import { Client, ScheduleOverlapPolicy } from '@temporalio/client';
import type { Config } from '../types.js';

async function ensureSchedule(
  client: Client,
  scheduleId: string,
  spec: { cronExpression: string; timezone: string },
  workflowType: string,
  args: unknown[],
): Promise<void> {
  // Idempotent: skip if already registered
  try {
    await client.schedule.getHandle(scheduleId).describe();
    return; // exists, nothing to do
  } catch {
    // does not exist — fall through to create
  }

  await client.schedule.create({
    scheduleId,
    spec: {
      cronExpressions: [spec.cronExpression],
      timezone: spec.timezone,
    },
    action: {
      type: 'startWorkflow',
      workflowType,
      args,
      taskQueue: 'ai-hub',
    },
    policies: {
      overlap: ScheduleOverlapPolicy.SKIP,
      catchupWindow: '1 day',
    },
  });

  console.log(`Registered Temporal schedule: ${scheduleId}`);
}

export async function registerSchedules(config: Config, client: Client): Promise<void> {
  for (const account of config.email.accounts) {
    await ensureSchedule(
      client,
      `email-triage-${account.name}`,
      { cronExpression: config.schedule.email_triage_cron, timezone: config.schedule.timezone },
      'emailTriageWorkflow',
      [account.name],
    );
  }

  await ensureSchedule(
    client,
    'daily-summary',
    { cronExpression: config.schedule.daily_summary_cron, timezone: config.schedule.timezone },
    'dailySummaryWorkflow',
    [],
  );
}
```

**Step 2: Verify build**

```bash
cd hub && npm run build
```

Expected: no errors.

**Step 3: Commit**

```bash
cd ..
git add hub/src/temporal/schedules.ts
git commit -m "feat(hub): add Temporal schedule registration"
```

---

## Task 7: Update `bot.ts`

Replace the direct `chat()` call with a Temporal workflow execution. The function signature of `createDiscordBot` changes — it now takes a Temporal `Client` instead of an `OpenAI` client.

**Files:**
- Modify: `hub/src/discord/bot.ts`

**Step 1: Update the file**

Replace the entire contents of `hub/src/discord/bot.ts`:

```typescript
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { Client as TemporalClient } from '@temporalio/client';
import type { Config } from '../types.js';
import { getDiscordToken } from '../config.js';
import { isAllowed, stripMention, resolveRoute } from './router.js';
import type { ChatWorkflow } from '../temporal/workflow-types.js';

const SYSTEM_PROMPT = 'You are a helpful AI assistant running on a private home server.';
const MAX_MSG_LENGTH = 2000;

function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_MSG_LENGTH) {
    chunks.push(remaining.slice(0, MAX_MSG_LENGTH));
    remaining = remaining.slice(MAX_MSG_LENGTH);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function createDiscordBot(config: Config, temporalClient: TemporalClient): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!isAllowed(message.author.id, config)) return;

    const isDM = message.channel.isDMBased();
    if (!isDM && !message.mentions.has(client.user!)) return;

    const rawContent = isDM ? message.content : stripMention(message.content);
    if (!rawContent) return;

    const channelName = isDM
      ? 'general'
      : ('name' in message.channel ? message.channel.name : 'general');

    const route = resolveRoute(channelName, rawContent, config);

    try {
      const reply = await temporalClient.workflow.execute<ChatWorkflow>(
        'chatWorkflow',
        {
          args: [route.model, SYSTEM_PROMPT, route.content],
          taskQueue: 'ai-hub',
          workflowId: `chat-${message.id}`,
        },
      );
      for (const chunk of splitMessage(reply)) {
        await message.reply(chunk);
      }
    } catch {
      await message.reply('⚠️ Model unavailable, try again in a moment.');
    }
  });

  return client;
}

export async function startDiscordBot(client: Client, config: Config): Promise<void> {
  const token = getDiscordToken(config);
  await client.login(token);
  return new Promise((resolve) => {
    client.once('ready', () => {
      console.log(`Discord bot ready: ${client.user?.tag}`);
      resolve();
    });
  });
}
```

**Step 2: Verify build**

```bash
cd hub && npm run build
```

Expected: no errors.

**Step 3: Run tests — router tests should still pass unchanged**

```bash
npm test
```

Expected: all tests pass. The router tests don't import `bot.ts`, so the signature change doesn't affect them.

**Step 4: Commit**

```bash
cd ..
git add hub/src/discord/bot.ts
git commit -m "feat(hub): route Discord chat through Temporal chatWorkflow"
```

---

## Task 8: Write final `index.ts`

Wires everything together. Startup order matters: Discord must be ready before worker starts (so guild cache is populated when activities run).

**Files:**
- Modify: `hub/src/index.ts`

**Step 1: Replace the file contents**

```typescript
import path from 'node:path';
import os from 'node:os';
import { Client as TemporalClient, Connection } from '@temporalio/client';
import { loadConfig } from './config.js';
import { createOllamaClient } from './ollama.js';
import { createDiscordBot, startDiscordBot } from './discord/bot.js';
import { createStateStore } from './email/state.js';
import { createWorker } from './temporal/worker.js';
import { registerSchedules } from './temporal/schedules.js';

async function main() {
  const config = loadConfig();
  const ollamaClient = createOllamaClient(config);

  const stateDir = process.env.STATE_DIR ?? path.join(os.homedir(), '.local/share/ai-hub');
  const stateStore = createStateStore(path.join(stateDir, 'state.db'));

  // Temporal client — shared by Discord bot and schedule registration
  const temporalAddress = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const connection = await Connection.connect({ address: temporalAddress });
  const temporalClient = new TemporalClient({ connection });

  // Start Discord bot first — guild cache must be warm before activities run
  const discordClient = createDiscordBot(config, temporalClient);
  await startDiscordBot(discordClient, config);

  // Start Temporal worker
  const worker = await createWorker({ ollamaClient, discordClient, config, stateStore });
  void worker.run().catch((err) => {
    console.error('Temporal worker error:', err);
    process.exit(1);
  });

  // Register schedules (idempotent — safe to run on every startup)
  await registerSchedules(config, temporalClient);

  console.log('AI Hub running. Temporal schedules registered.');

  process.on('SIGTERM', () => {
    void worker.shutdown();
    stateStore.close();
    discordClient.destroy();
    void connection.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

**Step 2: Verify build**

```bash
cd hub && npm run build
```

Expected: no errors, `dist/` updated.

**Step 3: Run full test suite**

```bash
npm test
```

Expected: all existing tests pass. Tests cover config, router, state, triage — none of these modules changed.

**Step 4: Commit**

```bash
cd ..
git add hub/src/index.ts
git commit -m "feat(hub): wire Temporal worker and schedules in main entrypoint"
```

---

## Task 9: Update `docker-compose.yml`

The compose file needs two new services and a new volume. This is part of the existing Task 5 deploy items, updated for the 4-container stack.

**Files:**
- Create: `deploy/docker-compose.yml`

**Step 1: Write the file**

```yaml
services:
  ai-hub:
    build:
      context: ../hub
      dockerfile: Dockerfile
    image: ai-hub:latest
    restart: unless-stopped
    depends_on:
      temporal:
        condition: service_healthy
    env_file:
      - /etc/ai-hub/hub.env
    environment:
      - CONFIG_PATH=/app/config.toml
      - STATE_DIR=/var/lib/ai-hub
      - TEMPORAL_ADDRESS=temporal:7233
    volumes:
      - /opt/ai-hub/config.toml:/app/config.toml:ro
      - hub-state:/var/lib/ai-hub
      - /var/run/docker.sock:/var/run/docker.sock
    extra_hosts:
      - "host.docker.internal:host-gateway"

  open-webui:
    image: ghcr.io/open-webui/open-webui:main
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:8080"
    environment:
      - OLLAMA_BASE_URL=http://host.docker.internal:11434
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - open-webui:/app/backend/data

  temporal:
    image: temporalio/auto-setup:latest
    restart: unless-stopped
    depends_on:
      postgresql:
        condition: service_healthy
    environment:
      - DB=postgres12
      - DB_PORT=5432
      - POSTGRES_USER=temporal
      - POSTGRES_PWD=temporal
      - POSTGRES_SEEDS=postgresql
    ports:
      - "127.0.0.1:7233:7233"
      - "127.0.0.1:8080:8080"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    healthcheck:
      test: ["CMD", "tctl", "--address", "temporal:7233", "cluster", "health"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s

  postgresql:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      - POSTGRES_PASSWORD=temporal
      - POSTGRES_USER=temporal
      - POSTGRES_DB=temporal
    volumes:
      - temporal-db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U temporal"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  hub-state:
  open-webui:
  temporal-db:
```

**Step 2: Verify the compose file is valid**

```bash
docker compose -f deploy/docker-compose.yml config --quiet
```

Expected: no errors printed.

**Step 3: Commit**

```bash
git add deploy/docker-compose.yml
git commit -m "feat(deploy): add Temporal and PostgreSQL to compose stack"
```

---

## Task 10: Final Verification

**Step 1: Full build**

```bash
cd hub && npm run build
```

Expected: clean build, no TypeScript errors.

**Step 2: Full test suite**

```bash
npm test
```

Expected: all tests pass.

**Step 3: Check for any remaining node-cron references**

```bash
grep -r "node-cron" src/
```

Expected: no output (node-cron fully removed).

**Step 4: Confirm new temporal directory was built**

```bash
ls dist/temporal/
```

Expected: `activities.js`, `workflow-types.js`, `workflows.js`, `worker.js`, `schedules.js` all present.

**Step 5: Final commit**

```bash
cd ..
git add hub/
git commit -m "chore(hub): verify Temporal integration build and tests clean"
```

---

## Checklist

- [ ] Task 1: Install @temporalio/* packages, remove node-cron
- [ ] Task 2: Write `workflow-types.ts`
- [ ] Task 3: Write `activities.ts` — delegates to existing imap/triage/ollama/state code
- [ ] Task 4: Write `workflows.ts` — only imports from `@temporalio/workflow`
- [ ] Task 5: Write `worker.ts` — NativeConnection, workflowsPath via import.meta.url
- [ ] Task 6: Write `schedules.ts` — idempotent schedule registration
- [ ] Task 7: Update `bot.ts` — use TemporalClient, workflow.execute('chatWorkflow', ...)
- [ ] Task 8: Write final `index.ts` — Discord first, then worker, then schedules
- [ ] Task 9: Write `docker-compose.yml` — 4-service stack with healthchecks
- [ ] Task 10: Final build + test verification
