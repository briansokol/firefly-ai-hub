# OpenClaw Replacement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace OpenClaw with Open WebUI (web dashboard) and a Node.js/TypeScript hub service (Discord bot, IMAP email triage, cron scheduling).

**Architecture:** Open WebUI runs in Docker as the Cloudflare Tunnel target and Ollama dashboard. The hub service is a single Node.js process using discord.js for the Discord gateway, node-cron for scheduling, imapflow for IMAP email, and better-sqlite3 to track per-account IMAP UIDs. Both services call Ollama directly and independently.

**Tech Stack:** Node.js 22, TypeScript, discord.js v14, node-cron, imapflow, openai (npm), better-sqlite3, smol-toml, vitest — plus Docker Compose for Open WebUI, systemd for both services.

**Reference:** `plans/2026-02-28-openclaw-replacement-design.md`

---

## Task 1: Project Scaffolding

**Files:**
- Create: `/opt/ai-hub/hub/package.json`
- Create: `/opt/ai-hub/hub/tsconfig.json`
- Create: `/opt/ai-hub/hub/src/index.ts`
- Create: `/opt/ai-hub/hub/src/types.ts`

**Step 1: Create the directory and initialize the project**

```bash
sudo mkdir -p /opt/ai-hub/hub
sudo chown openclaw:openclaw /opt/ai-hub/hub
mkdir -p /opt/ai-hub/hub/src /opt/ai-hub/hub/tests
cd /opt/ai-hub/hub
npm init -y
```

**Step 2: Install dependencies**

```bash
npm install discord.js@14 node-cron imapflow openai better-sqlite3 smol-toml
npm install -D typescript @types/node @types/better-sqlite3 @types/node-cron vitest tsx
```

**Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 4: Update `package.json` scripts**

Add to the `scripts` section:

```json
{
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

**Step 5: Write `src/types.ts`**

```typescript
export interface DiscordConfig {
  token_env: string;
  allowed_user_ids: string[];
  guild_id: string;
}

export interface ModelsConfig {
  default: string;
  coding: string;
  complex: string;
  ollama_base_url: string;
}

export interface ScheduleConfig {
  timezone: string;
  email_triage_cron: string;
  daily_summary_cron: string;
}

export interface EmailAccount {
  name: string;
  host: string;
  port: number;
  username: string;
  password_env: string;
  ssl: boolean;
  folders: string[];
}

export interface EmailConfig {
  accounts: EmailAccount[];
}

export interface Config {
  discord: DiscordConfig;
  models: ModelsConfig;
  schedule: ScheduleConfig;
  email: EmailConfig;
}
```

**Step 6: Write minimal `src/index.ts`**

```typescript
import { loadConfig } from './config.js';

async function main() {
  const config = loadConfig();
  console.log('AI Hub starting...');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

**Step 7: Verify TypeScript compiles**

```bash
npm run build
```

Expected: `dist/` directory created, no errors.

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: scaffold Node.js/TypeScript hub project"
```

---

## Task 2: Config Loading

**Files:**
- Create: `src/config.ts`
- Create: `tests/config.test.ts`
- Create: `/opt/ai-hub/config.toml.example`

**Step 1: Write the failing tests**

```typescript
// tests/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MINIMAL_TOML = `
[discord]
token_env = "DISCORD_TOKEN"
allowed_user_ids = ["123456789"]
guild_id = "987654321"

[models]
default = "qwen3:30b-a3b"
coding = "qwen2.5-coder:32b"
complex = "glm-4.7-flash"
ollama_base_url = "http://127.0.0.1:11434/v1"

[schedule]
timezone = "America/New_York"
email_triage_cron = "0 7 * * *"
daily_summary_cron = "0 21 * * *"

[[email.accounts]]
name = "fastmail"
host = "imap.fastmail.com"
port = 993
username = "user@fastmail.com"
password_env = "FASTMAIL_PASSWORD"
ssl = true
folders = ["INBOX"]
`;

describe('loadConfig', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `hub-test-${Date.now()}.toml`);
    fs.writeFileSync(tmpFile, MINIMAL_TOML);
    process.env.CONFIG_PATH = tmpFile;
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.FASTMAIL_PASSWORD = 'test-pw';
  });

  afterEach(() => {
    fs.unlinkSync(tmpFile);
    delete process.env.CONFIG_PATH;
    delete process.env.DISCORD_TOKEN;
    delete process.env.FASTMAIL_PASSWORD;
  });

  it('loads and parses a valid config', () => {
    const config = loadConfig();
    expect(config.discord.allowed_user_ids).toEqual(['123456789']);
    expect(config.models.default).toBe('qwen3:30b-a3b');
    expect(config.email.accounts).toHaveLength(1);
    expect(config.email.accounts[0].name).toBe('fastmail');
  });

  it('throws if a required env var is missing', () => {
    delete process.env.DISCORD_TOKEN;
    expect(() => loadConfig()).toThrow(/DISCORD_TOKEN/);
  });

  it('throws if config file does not exist', () => {
    process.env.CONFIG_PATH = '/nonexistent/config.toml';
    expect(() => loadConfig()).toThrow();
  });
});
```

**Step 2: Run to confirm failure**

```bash
npm test
```

Expected: FAIL — `src/config.ts` does not exist.

**Step 3: Write `src/config.ts`**

```typescript
import fs from 'node:fs';
import { parse } from 'smol-toml';
import type { Config } from './types.js';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

export function loadConfig(): Config {
  const configPath = process.env.CONFIG_PATH ?? '/opt/ai-hub/config.toml';
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = parse(raw) as Config;

  // Validate that all secrets are present before starting
  requireEnv(parsed.discord.token_env);
  for (const account of parsed.email.accounts) {
    requireEnv(account.password_env);
  }

  return parsed;
}

export function getDiscordToken(config: Config): string {
  return requireEnv(config.discord.token_env);
}

export function getEmailPassword(account: { password_env: string }): string {
  return requireEnv(account.password_env);
}
```

**Step 4: Run tests to confirm pass**

```bash
npm test
```

Expected: PASS — 3 tests passing.

**Step 5: Write `/opt/ai-hub/config.toml.example`**

```toml
[discord]
token_env = "DISCORD_TOKEN"
allowed_user_ids = ["YOUR_DISCORD_USER_ID"]
guild_id = "YOUR_GUILD_ID"

[models]
default = "qwen3:30b-a3b"
coding  = "qwen2.5-coder:32b"
complex = "glm-4.7-flash"
ollama_base_url = "http://127.0.0.1:11434/v1"

[schedule]
timezone = "America/New_York"
email_triage_cron  = "0 7 * * *"
daily_summary_cron = "0 21 * * *"

[[email.accounts]]
name = "gmail"
host = "imap.gmail.com"
port = 993
username = "you@gmail.com"
password_env = "GMAIL_APP_PASSWORD"
ssl = true
folders = ["INBOX"]

[[email.accounts]]
name = "outlook"
host = "outlook.office365.com"
port = 993
username = "you@outlook.com"
password_env = "OUTLOOK_PASSWORD"
ssl = true
folders = ["INBOX"]

[[email.accounts]]
name = "fastmail"
host = "imap.fastmail.com"
port = 993
username = "you@fastmail.com"
password_env = "FASTMAIL_APP_PASSWORD"
ssl = true
folders = ["INBOX"]
```

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: add config loading with env var secret resolution"
```

---

## Task 3: Ollama Client

**Files:**
- Create: `src/ollama.ts`

No unit tests for this module — it is a thin wrapper around the `openai` npm package with no independent logic. Tested end-to-end in Task 5.

**Step 1: Write `src/ollama.ts`**

```typescript
import OpenAI from 'openai';
import type { Config } from './types.js';

export function createOllamaClient(config: Config): OpenAI {
  return new OpenAI({
    baseURL: config.models.ollama_base_url,
    apiKey: 'ollama', // Ollama does not require a real key
  });
}

export async function chat(
  client: OpenAI,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });

  return response.choices[0]?.message?.content ?? '(no response)';
}
```

**Step 2: Compile to confirm no type errors**

```bash
npm run build
```

Expected: no errors.

**Step 3: Commit**

```bash
git add src/ollama.ts
git commit -m "feat: add thin Ollama client wrapper"
```

---

## Task 4: Discord Routing Logic

**Files:**
- Create: `src/discord/router.ts`
- Create: `tests/router.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/router.test.ts
import { describe, it, expect } from 'vitest';
import { resolveRoute, isAllowed, stripMention } from '../src/discord/router.js';
import type { Config } from '../src/types.js';

const config = {
  discord: {
    allowed_user_ids: ['111', '222'],
    guild_id: '999',
    token_env: 'DISCORD_TOKEN',
  },
  models: {
    default: 'qwen3:30b-a3b',
    coding: 'qwen2.5-coder:32b',
    complex: 'glm-4.7-flash',
    ollama_base_url: 'http://127.0.0.1:11434/v1',
  },
} as unknown as Config;

describe('isAllowed', () => {
  it('allows a user in the allowlist', () => {
    expect(isAllowed('111', config)).toBe(true);
  });

  it('blocks a user not in the allowlist', () => {
    expect(isAllowed('333', config)).toBe(false);
  });
});

describe('resolveRoute', () => {
  it('routes #coding channel to coding model', () => {
    const route = resolveRoute('coding', 'write a function', config);
    expect(route.model).toBe('qwen2.5-coder:32b');
  });

  it('routes #general to default model', () => {
    const route = resolveRoute('general', 'hello', config);
    expect(route.model).toBe('qwen3:30b-a3b');
  });

  it('routes /think prefix to complex model regardless of channel', () => {
    const route = resolveRoute('general', '/think explain quantum entanglement', config);
    expect(route.model).toBe('glm-4.7-flash');
  });

  it('strips /think prefix from the message content', () => {
    const route = resolveRoute('general', '/think explain this', config);
    expect(route.content).toBe('explain this');
  });

  it('returns sandbox=true for coding channel', () => {
    const route = resolveRoute('coding', 'run this code', config);
    expect(route.sandbox).toBe(true);
  });

  it('returns sandbox=false for non-coding channels', () => {
    const route = resolveRoute('general', 'hello', config);
    expect(route.sandbox).toBe(false);
  });
});

describe('stripMention', () => {
  it('removes a leading bot mention', () => {
    expect(stripMention('<@123456789> what is 2+2?')).toBe('what is 2+2?');
  });

  it('returns unchanged string with no mention', () => {
    expect(stripMention('what is 2+2?')).toBe('what is 2+2?');
  });
});
```

**Step 2: Run to confirm failure**

```bash
npm test
```

Expected: FAIL — module not found.

**Step 3: Write `src/discord/router.ts`**

```typescript
import type { Config } from '../types.js';

export interface Route {
  model: string;
  content: string;
  sandbox: boolean;
}

export function isAllowed(userId: string, config: Config): boolean {
  return config.discord.allowed_user_ids.includes(userId);
}

export function stripMention(content: string): string {
  return content.replace(/^<@!?\d+>\s*/, '').trim();
}

export function resolveRoute(channelName: string, content: string, config: Config): Route {
  if (content.startsWith('/think ')) {
    return {
      model: config.models.complex,
      content: content.slice('/think '.length).trim(),
      sandbox: false,
    };
  }

  if (channelName === 'coding') {
    return { model: config.models.coding, content, sandbox: true };
  }

  return { model: config.models.default, content, sandbox: false };
}
```

**Step 4: Run tests to confirm pass**

```bash
npm test
```

Expected: PASS — all router tests passing.

**Step 5: Commit**

```bash
git add src/discord/router.ts tests/router.test.ts
git commit -m "feat: add Discord routing logic with allowlist and model selection"
```

---

## Task 5: Discord Bot

**Files:**
- Create: `src/discord/bot.ts`
- Modify: `src/index.ts`

No unit tests — discord.js requires a live gateway connection. Manual smoke test described below.

**Step 1: Write `src/discord/bot.ts`**

```typescript
import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
} from 'discord.js';
import type OpenAI from 'openai';
import type { Config } from '../types.js';
import { isAllowed, resolveRoute, stripMention } from './router.js';
import { chat } from '../ollama.js';

const SYSTEM_PROMPTS = {
  default: 'You are a helpful personal assistant. Be concise and direct.',
  coding: 'You are an expert software engineer. Provide working code with brief explanations.',
  complex: 'You are a thoughtful analyst. Think step by step before answering.',
};

function getSystemPrompt(model: string, config: Config): string {
  if (model === config.models.coding) return SYSTEM_PROMPTS.coding;
  if (model === config.models.complex) return SYSTEM_PROMPTS.complex;
  return SYSTEM_PROMPTS.default;
}

async function handleMessage(
  message: Message,
  config: Config,
  ollamaClient: OpenAI,
): Promise<void> {
  if (message.author.bot) return;
  if (!isAllowed(message.author.id, config)) return;

  const isDM = message.channel.isDMBased();
  const isMentioned = message.mentions.has(message.client.user!);
  if (!isDM && !isMentioned) return;

  const rawContent = stripMention(message.content);
  if (!rawContent) return;

  const channelName = isDM ? 'general' : (message.channel as TextChannel).name;
  const route = resolveRoute(channelName, rawContent, config);

  await message.channel.sendTyping();

  try {
    const systemPrompt = getSystemPrompt(route.model, config);
    const response = await chat(ollamaClient, route.model, systemPrompt, route.content);

    // Discord has a 2000 character limit — split if needed
    if (response.length <= 2000) {
      await message.reply(response);
    } else {
      const chunks = response.match(/[\s\S]{1,1990}/g) ?? [];
      for (const chunk of chunks) {
        await message.channel.send(chunk);
      }
    }
  } catch (err) {
    console.error('Error calling Ollama:', err);
    await message.reply('⚠️ Model unavailable, try again in a moment.');
  }
}

export function createDiscordBot(config: Config, ollamaClient: OpenAI): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // Privileged intent — enable in Discord dev portal
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel], // Required for DM support
  });

  client.once('ready', () => {
    console.log(`Discord bot ready: ${client.user?.tag}`);
  });

  client.on('messageCreate', (message) => {
    handleMessage(message, config, ollamaClient).catch((err) => {
      console.error('Unhandled error in messageCreate:', err);
    });
  });

  return client;
}

export async function startDiscordBot(client: Client, config: Config): Promise<void> {
  const token = process.env[config.discord.token_env];
  if (!token) throw new Error(`Env var ${config.discord.token_env} is not set`);
  await client.login(token);
}
```

**Step 2: Update `src/index.ts`**

```typescript
import { loadConfig } from './config.js';
import { createOllamaClient } from './ollama.js';
import { createDiscordBot, startDiscordBot } from './discord/bot.js';

async function main() {
  const config = loadConfig();
  const ollamaClient = createOllamaClient(config);
  const discordClient = createDiscordBot(config, ollamaClient);
  await startDiscordBot(discordClient, config);
  console.log('AI Hub running.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

**Step 3: Compile**

```bash
npm run build
```

Expected: no errors.

**Step 4: Manual smoke test**

Prerequisites:
- Create a Discord application at https://discord.com/developers
- Under Bot → Privileged Gateway Intents, enable `Message Content Intent`
- Generate a bot token
- Invite the bot to your server with scopes `bot` and permissions: Send Messages, Read Message History, Embed Links

```bash
export DISCORD_TOKEN=your_bot_token_here
export CONFIG_PATH=/opt/ai-hub/config.toml
npm run dev
```

Expected: `Discord bot ready: YourBot#1234` in console. Send @mention in `#general`, bot replies via Ollama.

**Step 5: Commit**

```bash
git add src/discord/bot.ts src/index.ts
git commit -m "feat: add Discord bot with channel routing and Ollama integration"
```

---

## Task 6: IMAP State Tracking

**Files:**
- Create: `src/email/state.ts`
- Create: `tests/state.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/state.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStateStore, type StateStore } from '../src/email/state.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('StateStore', () => {
  let dbPath: string;
  let store: StateStore;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `state-test-${Date.now()}.db`);
    store = createStateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.unlinkSync(dbPath);
  });

  it('returns 0 as the last UID for an unseen account', () => {
    expect(store.getLastUid('gmail')).toBe(0);
  });

  it('stores and retrieves the last UID', () => {
    store.setLastUid('gmail', 42);
    expect(store.getLastUid('gmail')).toBe(42);
  });

  it('isolates UIDs per account', () => {
    store.setLastUid('gmail', 10);
    store.setLastUid('fastmail', 99);
    expect(store.getLastUid('gmail')).toBe(10);
    expect(store.getLastUid('fastmail')).toBe(99);
  });

  it('updates the UID on subsequent calls', () => {
    store.setLastUid('gmail', 5);
    store.setLastUid('gmail', 20);
    expect(store.getLastUid('gmail')).toBe(20);
  });
});
```

**Step 2: Run to confirm failure**

```bash
npm test
```

Expected: FAIL — module not found.

**Step 3: Write `src/email/state.ts`**

```typescript
import Database from 'better-sqlite3';

export interface StateStore {
  getLastUid(account: string): number;
  setLastUid(account: string, uid: number): void;
  close(): void;
}

export function createStateStore(dbPath: string): StateStore {
  const db = new Database(dbPath);

  // Use prepare().run() to avoid shell-style exec patterns
  db.prepare(`
    CREATE TABLE IF NOT EXISTS imap_state (
      account TEXT PRIMARY KEY,
      last_uid INTEGER NOT NULL DEFAULT 0
    )
  `).run();

  const getStmt = db.prepare<[string], { last_uid: number }>(
    'SELECT last_uid FROM imap_state WHERE account = ?'
  );
  const upsertStmt = db.prepare(
    `INSERT INTO imap_state (account, last_uid) VALUES (?, ?)
     ON CONFLICT(account) DO UPDATE SET last_uid = excluded.last_uid`
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
```

**Step 4: Run tests to confirm pass**

```bash
npm test
```

Expected: PASS — 4 state tests passing.

**Step 5: Commit**

```bash
git add src/email/state.ts tests/state.test.ts
git commit -m "feat: add SQLite-backed IMAP UID state tracking"
```

---

## Task 7: IMAP Email Fetcher

**Files:**
- Create: `src/email/imap.ts`

No unit tests — imapflow requires a live IMAP server. Exercised through manual email triage trigger in Task 9.

**Step 1: Write `src/email/imap.ts`**

```typescript
import { ImapFlow } from 'imapflow';
import type { EmailAccount } from '../types.js';
import { getEmailPassword } from '../config.js';

export interface FetchedEmail {
  uid: number;
  subject: string;
  from: string;
  date: string;
  snippet: string; // First 500 chars of plain text body
}

export async function fetchUnseenEmails(
  account: EmailAccount,
  sinceUid: number,
): Promise<{ emails: FetchedEmail[]; maxUid: number }> {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.ssl,
    auth: {
      user: account.username,
      pass: getEmailPassword(account),
    },
    logger: false,
  });

  const emails: FetchedEmail[] = [];
  let maxUid = sinceUid;

  await client.connect();

  try {
    const lock = await client.getMailboxLock(account.folders[0] ?? 'INBOX');

    try {
      const searchCriteria = sinceUid > 0
        ? { uid: `${sinceUid + 1}:*` }
        : { seen: false };

      for await (const message of client.fetch(searchCriteria, {
        uid: true,
        envelope: true,
        bodyParts: ['TEXT'],
      })) {
        const uid = message.uid;
        if (uid <= sinceUid) continue;

        const envelope = message.envelope;
        const from = envelope.from?.[0]?.address ?? 'unknown';
        const subject = envelope.subject ?? '(no subject)';
        const date = envelope.date?.toISOString() ?? '';
        const bodyText = message.bodyParts?.get('TEXT')?.toString() ?? '';
        const snippet = bodyText.slice(0, 500).replace(/\s+/g, ' ').trim();

        emails.push({ uid, subject, from, date, snippet });
        if (uid > maxUid) maxUid = uid;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return { emails, maxUid };
}
```

**Step 2: Compile**

```bash
npm run build
```

Expected: no errors.

**Step 3: Commit**

```bash
git add src/email/imap.ts
git commit -m "feat: add IMAP email fetcher with UID-based incremental fetch"
```

---

## Task 8: Email Triage — Prompt Builder

**Files:**
- Create: `src/email/triage.ts`
- Create: `tests/triage.test.ts`

The prompt builder is the testable unit. The Discord and IMAP calls are wired together in Task 9.

**Step 1: Write the failing tests**

```typescript
// tests/triage.test.ts
import { describe, it, expect } from 'vitest';
import { buildTriagePrompt } from '../src/email/triage.js';
import type { FetchedEmail } from '../src/email/imap.js';

const emails: FetchedEmail[] = [
  {
    uid: 1,
    subject: 'Meeting tomorrow at 9am',
    from: 'boss@company.com',
    date: '2026-02-28T14:00:00Z',
    snippet: 'Can you join the call tomorrow?',
  },
  {
    uid: 2,
    subject: 'Your Amazon order has shipped',
    from: 'noreply@amazon.com',
    date: '2026-02-28T10:00:00Z',
    snippet: 'Your package is on its way.',
  },
];

describe('buildTriagePrompt', () => {
  it('includes all email subjects in the prompt', () => {
    const prompt = buildTriagePrompt(emails);
    expect(prompt).toContain('Meeting tomorrow at 9am');
    expect(prompt).toContain('Your Amazon order has shipped');
  });

  it('includes sender information', () => {
    const prompt = buildTriagePrompt(emails);
    expect(prompt).toContain('boss@company.com');
  });

  it('requests JSON output', () => {
    const prompt = buildTriagePrompt(emails);
    expect(prompt.toLowerCase()).toContain('json');
  });

  it('returns a non-empty string for an empty email list', () => {
    const prompt = buildTriagePrompt([]);
    expect(prompt.length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run to confirm failure**

```bash
npm test
```

Expected: FAIL — module not found.

**Step 3: Write `src/email/triage.ts` (prompt builder only for now)**

```typescript
import type { FetchedEmail } from './imap.js';

export function buildTriagePrompt(emails: FetchedEmail[]): string {
  if (emails.length === 0) {
    return 'No new emails to triage.';
  }

  const emailList = emails
    .map(
      (e, i) =>
        `Email ${i + 1}:\n  From: ${e.from}\n  Subject: ${e.subject}\n  Date: ${e.date}\n  Preview: ${e.snippet}`,
    )
    .join('\n\n');

  return `You are an email triage assistant. Categorize these emails and identify action items.

${emailList}

Respond in JSON with this structure:
{
  "summary": "One sentence summary of all emails",
  "emails": [
    {
      "subject": "...",
      "from": "...",
      "category": "action-required | fyi | newsletter | notification | other",
      "priority": "high | medium | low",
      "action": "What I should do, or null if no action needed"
    }
  ],
  "action_items": ["List of emails needing a response or action"]
}`;
}
```

**Step 4: Run tests to confirm pass**

```bash
npm test
```

Expected: PASS — all triage tests passing.

**Step 5: Commit**

```bash
git add src/email/triage.ts tests/triage.test.ts
git commit -m "feat: add email triage prompt builder with tests"
```

---

## Task 9: Email Triage Runner + Daily Summary

**Files:**
- Modify: `src/email/triage.ts` (add the runner function)
- Create: `src/cron/daily-summary.ts`

**Step 1: Add the triage runner to `src/email/triage.ts`**

Append below the existing `buildTriagePrompt` export:

```typescript
import type OpenAI from 'openai';
import type { Client, TextChannel } from 'discord.js';
import type { Config } from '../types.js';
import type { StateStore } from './state.js';
import { fetchUnseenEmails } from './imap.js';

interface TriageResult {
  summary: string;
  action_items: string[];
}

export async function runEmailTriage(
  config: Config,
  ollamaClient: OpenAI,
  discordClient: Client,
  stateStore: StateStore,
): Promise<void> {
  const guild = await discordClient.guilds.fetch(config.discord.guild_id);
  const channels = guild.channels.cache;
  const emailChannel = channels.find((c) => c.name === 'email') as TextChannel | undefined;
  const alertsChannel = channels.find((c) => c.name === 'alerts') as TextChannel | undefined;
  const adminChannel = channels.find((c) => c.name === 'admin') as TextChannel | undefined;

  for (const account of config.email.accounts) {
    try {
      const lastUid = stateStore.getLastUid(account.name);
      const { emails, maxUid } = await fetchUnseenEmails(account, lastUid);
      if (emails.length === 0) continue;

      const prompt = buildTriagePrompt(emails);
      const response = await ollamaClient.chat.completions.create({
        model: config.models.default,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      });

      const raw = response.choices[0]?.message?.content ?? '{}';
      const result: TriageResult = JSON.parse(raw);

      stateStore.setLastUid(account.name, maxUid);

      if (emailChannel) {
        await emailChannel.send(
          `**[${account.name}]** ${result.summary}\n${emails.length} new email(s).`,
        );
      }

      if (alertsChannel && result.action_items.length > 0) {
        const bullets = result.action_items.map((a) => `• ${a}`).join('\n');
        await alertsChannel.send(`**Action items from [${account.name}]:**\n${bullets}`);
      }
    } catch (err) {
      console.error(`Email triage failed for account ${account.name}:`, err);
      await adminChannel?.send(
        `⚠️ Email triage failed for **${account.name}**. Check server logs.`,
      );
    }
  }
}
```

**Step 2: Write `src/cron/daily-summary.ts`**

```typescript
import type OpenAI from 'openai';
import type { Client, TextChannel } from 'discord.js';
import type { Config } from '../types.js';

export async function runDailySummary(
  config: Config,
  ollamaClient: OpenAI,
  discordClient: Client,
): Promise<void> {
  const guild = await discordClient.guilds.fetch(config.discord.guild_id);
  const channels = guild.channels.cache;
  const summaryChannel = channels.find((c) => c.name === 'daily-summary') as TextChannel | undefined;
  const adminChannel = channels.find((c) => c.name === 'admin') as TextChannel | undefined;

  try {
    const today = new Date().toDateString();
    const prompt = `Write a brief daily summary for a personal AI assistant hub.
Today is ${today}. Include a greeting, note that automated tasks ran, and remind
the user to check #email and #alerts for pending action items.
Keep it to 3-4 sentences, friendly and concise.`;

    const response = await ollamaClient.chat.completions.create({
      model: config.models.default,
      messages: [{ role: 'user', content: prompt }],
    });

    const summary = response.choices[0]?.message?.content ?? 'Daily summary unavailable.';
    await summaryChannel?.send(`📋 **Daily Summary — ${today}**\n\n${summary}`);
  } catch (err) {
    console.error('Daily summary failed:', err);
    await adminChannel?.send('⚠️ Daily summary failed. Check server logs.');
  }
}
```

**Step 3: Run all tests**

```bash
npm test
```

Expected: PASS — all 17 tests passing.

**Step 4: Commit**

```bash
git add src/email/triage.ts src/cron/daily-summary.ts
git commit -m "feat: add email triage runner and daily summary cron job"
```

---

## Task 10: Wire Up Cron Scheduler

**Files:**
- Modify: `src/index.ts`

**Step 1: Update `src/index.ts`**

```typescript
import cron from 'node-cron';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from './config.js';
import { createOllamaClient } from './ollama.js';
import { createDiscordBot, startDiscordBot } from './discord/bot.js';
import { createStateStore } from './email/state.js';
import { runEmailTriage } from './email/triage.js';
import { runDailySummary } from './cron/daily-summary.js';

async function main() {
  const config = loadConfig();
  const ollamaClient = createOllamaClient(config);

  const stateDir = process.env.STATE_DIR ?? path.join(os.homedir(), '.local/share/ai-hub');
  const stateStore = createStateStore(path.join(stateDir, 'state.db'));

  const discordClient = createDiscordBot(config, ollamaClient);
  await startDiscordBot(discordClient, config);

  cron.schedule(
    config.schedule.email_triage_cron,
    () => {
      runEmailTriage(config, ollamaClient, discordClient, stateStore).catch((err) =>
        console.error('Email triage cron error:', err),
      );
    },
    { timezone: config.schedule.timezone },
  );

  cron.schedule(
    config.schedule.daily_summary_cron,
    () => {
      runDailySummary(config, ollamaClient, discordClient).catch((err) =>
        console.error('Daily summary cron error:', err),
      );
    },
    { timezone: config.schedule.timezone },
  );

  console.log('AI Hub running. Cron jobs scheduled.');

  process.on('SIGTERM', () => {
    console.log('Shutting down...');
    stateStore.close();
    discordClient.destroy();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

**Step 2: Compile and run all tests**

```bash
npm run build && npm test
```

Expected: build succeeds, all 17 tests pass.

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire up cron scheduler and graceful shutdown"
```

---

## Task 11: Systemd Service for the Hub

**Files:**
- Create: `/etc/systemd/system/ai-hub.service`
- Create: `/etc/ai-hub/hub.env` (secrets — never commit)

**Step 1: Create the secrets env file**

```bash
sudo mkdir -p /etc/ai-hub
sudo touch /etc/ai-hub/hub.env
sudo chmod 600 /etc/ai-hub/hub.env
sudo chown openclaw:openclaw /etc/ai-hub/hub.env
```

Edit with `sudo -e /etc/ai-hub/hub.env` and fill in real values:

```ini
DISCORD_TOKEN=your_bot_token_here
GMAIL_APP_PASSWORD=your_gmail_app_password
OUTLOOK_PASSWORD=your_outlook_password
FASTMAIL_APP_PASSWORD=your_fastmail_app_password
```

Remove env vars for any accounts not configured in `config.toml`.

**Step 2: Build for production**

```bash
cd /opt/ai-hub/hub
npm run build
```

**Step 3: Create `/etc/systemd/system/ai-hub.service`**

```ini
[Unit]
Description=AI Hub Discord Bot and Scheduler
After=network.target ollama.service
Wants=ollama.service

[Service]
Type=simple
User=openclaw
Group=openclaw
WorkingDirectory=/opt/ai-hub/hub
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10

EnvironmentFile=/etc/ai-hub/hub.env
Environment=CONFIG_PATH=/opt/ai-hub/config.toml
Environment=STATE_DIR=/var/lib/ai-hub

NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

**Step 4: Create the state directory**

```bash
sudo mkdir -p /var/lib/ai-hub
sudo chown openclaw:openclaw /var/lib/ai-hub
```

**Step 5: Enable and start**

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-hub
```

**Step 6: Verify**

```bash
sudo systemctl status ai-hub
journalctl -u ai-hub -f
```

Expected: `Active: active (running)` and `AI Hub running. Cron jobs scheduled.` in journal.

**Step 7: Commit systemd unit to repo**

```bash
cp /etc/systemd/system/ai-hub.service /opt/ai-hub/ai-hub.service.example
git add /opt/ai-hub/ai-hub.service.example
git commit -m "chore: add systemd unit file example for reference"
```

---

## Task 12: Open WebUI (Docker + Systemd)

**Files:**
- Create: `/opt/ai-hub/docker-compose.yml`
- Create: `/etc/systemd/system/ai-hub-webui.service`

**Step 1: Write `/opt/ai-hub/docker-compose.yml`**

```yaml
services:
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

volumes:
  open-webui:
```

**Step 2: Create `/etc/systemd/system/ai-hub-webui.service`**

```ini
[Unit]
Description=AI Hub Open WebUI
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/ai-hub
ExecStart=/usr/bin/docker compose up
ExecStop=/usr/bin/docker compose down
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**Step 3: Enable and start**

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-hub-webui
```

**Step 4: Verify**

```bash
sudo systemctl status ai-hub-webui
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000
```

Expected: `200`.

**Step 5: Update Cloudflare Tunnel target**

Edit `~/.cloudflared/config.yml`, change the service line:

```yaml
ingress:
  - hostname: hub.yourdomain.com
    service: http://localhost:3000   # was :3007 (OpenClaw), now :3000 (Open WebUI)
  - service: http_status:404
```

```bash
sudo systemctl restart cloudflared
```

**Step 6: Commit**

```bash
git add /opt/ai-hub/docker-compose.yml
git commit -m "feat: add Open WebUI Docker Compose and systemd service"
```

---

## Task 13: Update tasks.md

**Files:**
- Modify: `plans/tasks.md`

**Step 1: Replace Phase 2 and Phase 3 content**

In `plans/tasks.md`, mark the old OpenClaw tasks (5–10) as superseded and replace with:

```markdown
## Phase 2: Hub Service + Discord ✦ (replaces OpenClaw tasks)

### 5. Hub Service Build & Deploy
- [ ] Build Node.js hub service: `cd /opt/ai-hub/hub && npm install && npm run build`
- [ ] Copy and edit config: `cp /opt/ai-hub/config.toml.example /opt/ai-hub/config.toml`
- [ ] Set up secrets file: `sudo -e /etc/ai-hub/hub.env`
- [ ] Create state dir: `sudo mkdir -p /var/lib/ai-hub && sudo chown openclaw:openclaw /var/lib/ai-hub`
- [ ] Enable and start service: `sudo systemctl enable --now ai-hub`
- [ ] Verify: `journalctl -u ai-hub -f` shows "AI Hub running"

### 6. Discord Bot Setup
- [ ] Create Discord application at discord.com/developers
- [ ] Enable Message Content Intent (Bot → Privileged Gateway Intents)
- [ ] Generate bot token and add to `/etc/ai-hub/hub.env`
- [ ] Create Discord server with channels: `#general`, `#coding`, `#email`, `#alerts`, `#daily-summary`, `#admin`
- [ ] Invite bot with scopes: `bot` — permissions: Send Messages, Read Message History, Embed Links
- [ ] Add your Discord user ID and guild ID to `config.toml`
- [ ] Restart service: `sudo systemctl restart ai-hub`

### 7. Chat Agent — End-to-End Validation
- [ ] Send @mention in `#general` → verify Ollama response (qwen3:30b-a3b)
- [ ] Send @mention in `#coding` → verify coding model response (qwen2.5-coder:32b)
- [ ] Send `/think <question>` → verify complex model response (glm-4.7-flash)
- [ ] Verify non-allowlisted user is silently ignored

## Phase 3: Agents & Automation ✦ (replaces OpenClaw tasks)

### 8. Email Integration
- [ ] Add IMAP credentials for each account to `/etc/ai-hub/hub.env`
- [ ] Configure `[[email.accounts]]` sections in `config.toml`
- [ ] Trigger email triage manually to test (temporarily call `runEmailTriage` on startup)
- [ ] Verify triage results post to `#email` and action items to `#alerts`
- [ ] Restore normal cron-only behavior, restart service

### 9. Open WebUI Deploy
- [ ] Deploy: `sudo systemctl enable --now ai-hub-webui`
- [ ] Verify: `curl http://localhost:3000` returns HTTP 200
- [ ] Update Cloudflare Tunnel target from `:3007` to `:3000`
- [ ] Verify external access via `hub.yourdomain.com`
```

**Step 2: Commit**

```bash
git add plans/tasks.md
git commit -m "chore: update task list for OpenClaw replacement"
```

---

## Test Summary

Run all tests at any point with:

```bash
cd /opt/ai-hub/hub && npm test
```

| Test file | Tests | What it covers |
|---|---|---|
| `tests/config.test.ts` | 3 | Config parsing, env var validation |
| `tests/router.test.ts` | 8 | Channel routing, allowlist, mention stripping |
| `tests/state.test.ts` | 4 | IMAP UID persistence, per-account isolation |
| `tests/triage.test.ts` | 4 | Email triage prompt building |
| **Total** | **19** | |
