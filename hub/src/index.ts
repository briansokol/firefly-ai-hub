import path from 'node:path';
import os from 'node:os';
import { RgbStateManager } from './rgb.js';
import { Client as TemporalClient, Connection } from '@temporalio/client';
import { loadConfig } from './config.js';
import { createOllamaClient } from './ollama.js';
import { createDiscordBot, startDiscordBot } from './discord/bot.js';
import { createStateStore } from './email/state.js';
import { createConversationStore } from './discord/conversation.js';
import { createWebToolsHttpServer } from './web/http.js';
import { createSyncStore, ensureDatabaseExists } from './sync/store.js';
import { createSyncHttpServer } from './sync/http.js';
import type { LitellmConfig } from './sync/litellm.js';
import { search as qdrantSearch } from './sync/qdrant.js';
import { embed } from './ollama.js';
import { MEMORY_COLLECTION, EMBED_MODEL } from './temporal/activities.js';
import { createWorker } from './temporal/worker.js';
import { registerSchedules } from './temporal/schedules.js';

const WEB_TOOLS_HTTP_PORT = 8787;
const SYNC_HTTP_PORT = 8788;

async function main() {
  const config = loadConfig();
  const ollamaClient = createOllamaClient(config);

  const memoryApiToken = process.env.MEMORY_API_TOKEN;
  if (!memoryApiToken) {
    console.error('MEMORY_API_TOKEN env var is required (set in /etc/ai-hub/hub.env)');
    process.exit(1);
  }

  const syncApiToken = process.env.SYNC_API_TOKEN;
  if (!syncApiToken) {
    console.error('SYNC_API_TOKEN env var is required (set in /etc/ai-hub/hub.env)');
    process.exit(1);
  }
  const syncDbUrl = process.env.SYNC_DB_URL;
  if (!syncDbUrl) {
    console.error('SYNC_DB_URL env var is required (set in /etc/ai-hub/hub.env)');
    process.exit(1);
  }
  const qdrantUrl = process.env.QDRANT_URL ?? 'http://localhost:6333';

  const stateDir = process.env.STATE_DIR ?? path.join(os.homedir(), '.local/share/firefly-ai-hub');
  const dbPath = path.join(stateDir, 'state.db');
  const stateStore = createStateStore(dbPath);
  const conversationStore = createConversationStore(dbPath);

  const webToolsHttpServer = createWebToolsHttpServer(memoryApiToken, config);
  await new Promise<void>((resolve, reject) => {
    webToolsHttpServer.once('error', reject);
    webToolsHttpServer.listen(WEB_TOOLS_HTTP_PORT, '0.0.0.0', () => {
      webToolsHttpServer.off('error', reject);
      resolve();
    });
  });
  console.log(`Web tools HTTP API listening on :${WEB_TOOLS_HTTP_PORT}`);

  // Sync service (Postgres-backed delta sync for app clients). Creates the
  // firefly_sync database + schema on first boot.
  const syncStore = await createSyncStore(syncDbUrl);
  // LiteLLM stores virtual keys in its own Postgres DB; create it if missing.
  // LiteLLM runs its own Prisma migrations on boot and self-heals via restart policy.
  const litellmDbUrl = process.env.LITELLM_DB_URL;
  if (litellmDbUrl) {
    await ensureDatabaseExists(litellmDbUrl);
  }
  const memorySearch = async (userId: string | undefined, q: string, k: number) => {
    const uid = userId ?? (await syncStore.getDefaultUserId());
    const vector = await embed(ollamaClient, EMBED_MODEL, q);
    const hits = await qdrantSearch(qdrantUrl, MEMORY_COLLECTION, vector, k, {
      key: 'user_id',
      value: uid,
    });
    const rows = await syncStore.getMemoriesByIds(hits.map((h) => h.id));
    // Preserve Qdrant's similarity ordering.
    const byId = new Map(rows.map((r) => [r.id, r]));
    return hits.map((h) => byId.get(h.id)).filter((r): r is NonNullable<typeof r> => Boolean(r));
  };
  const litellmConfig: LitellmConfig = {
    baseUrl: process.env.LITELLM_INTERNAL_URL ?? 'http://litellm:4000',
    masterKey: process.env.LITELLM_MASTER_KEY ?? '',
  };
  const syncHttpServer = createSyncHttpServer(syncStore, syncApiToken, litellmConfig, memorySearch);
  await new Promise<void>((resolve, reject) => {
    syncHttpServer.once('error', reject);
    syncHttpServer.listen(SYNC_HTTP_PORT, '0.0.0.0', () => {
      syncHttpServer.off('error', reject);
      resolve();
    });
  });
  console.log(`Sync HTTP API listening on :${SYNC_HTTP_PORT}`);

  // Temporal client — shared by Discord bot (starts chatWorkflow) and schedule registration
  const temporalAddress = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const connection = await Connection.connect({ address: temporalAddress });
  const temporalClient = new TemporalClient({ connection });

  const rgbManager = new RgbStateManager();
  await rgbManager.reset();

  // Discord bot must be ready before worker starts — guild cache must be warm for activities
  const discordClient = createDiscordBot(config, temporalClient, rgbManager, conversationStore);
  await startDiscordBot(discordClient, config);

  // Start Temporal worker (runs indefinitely in background)
  const worker = await createWorker({ ollamaClient, discordClient, config, stateStore, conversationStore, syncStore, qdrantUrl });
  void worker.run().catch((err) => {
    console.error('Temporal worker error:', err);
    process.exit(1);
  });

  // Register schedules (idempotent — safe on every restart)
  await registerSchedules(config, temporalClient);

  console.log('AI Hub running. Temporal schedules registered.');

  process.on('SIGTERM', () => {
    void rgbManager.reset();
    void worker.shutdown();
    webToolsHttpServer.close();
    syncHttpServer.close();
    void syncStore.close();
    stateStore.close();
    conversationStore.close();
    discordClient.destroy();
    void connection.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
