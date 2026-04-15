import path from 'node:path';
import os from 'node:os';
import { RgbStateManager } from './rgb.js';
import { Client as TemporalClient, Connection } from '@temporalio/client';
import { loadConfig } from './config.js';
import { createOllamaClient } from './ollama.js';
import { createDiscordBot, startDiscordBot } from './discord/bot.js';
import { createStateStore } from './email/state.js';
import { createConversationStore } from './discord/conversation.js';
import { createMemoryStore } from './memory/store.js';
import { createMemoryHttpServer } from './memory/http.js';
import { createWorker } from './temporal/worker.js';
import { registerSchedules } from './temporal/schedules.js';

const MEMORY_HTTP_PORT = 8787;

async function main() {
  const config = loadConfig();
  const ollamaClient = createOllamaClient(config);

  const memoryApiToken = process.env.MEMORY_API_TOKEN;
  if (!memoryApiToken) {
    console.error('MEMORY_API_TOKEN env var is required (set in /etc/ai-hub/hub.env)');
    process.exit(1);
  }

  const stateDir = process.env.STATE_DIR ?? path.join(os.homedir(), '.local/share/firefly-ai-hub');
  const dbPath = path.join(stateDir, 'state.db');
  const stateStore = createStateStore(dbPath);
  const conversationStore = createConversationStore(dbPath);
  const memoryStore = createMemoryStore(dbPath);

  const memoryHttpServer = createMemoryHttpServer(memoryStore, memoryApiToken, config);
  await new Promise<void>((resolve, reject) => {
    memoryHttpServer.once('error', reject);
    memoryHttpServer.listen(MEMORY_HTTP_PORT, '0.0.0.0', () => {
      memoryHttpServer.off('error', reject);
      resolve();
    });
  });
  console.log(`Memory HTTP API listening on :${MEMORY_HTTP_PORT}`);

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
  const worker = await createWorker({ ollamaClient, discordClient, config, stateStore, conversationStore, memoryStore });
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
    memoryHttpServer.close();
    stateStore.close();
    conversationStore.close();
    memoryStore.close();
    discordClient.destroy();
    void connection.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
