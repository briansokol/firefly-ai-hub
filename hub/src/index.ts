import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { RgbStateManager } from './rgb.js';
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

  const stateDir = process.env.STATE_DIR ?? path.join(os.homedir(), '.local/share/firefly-ai-hub');
  const stateStore = createStateStore(path.join(stateDir, 'state.db'));

  // Temporal client — shared by Discord bot (starts chatWorkflow) and schedule registration
  const temporalAddress = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const connection = await Connection.connect({ address: temporalAddress });
  const temporalClient = new TemporalClient({ connection });

  const RGB_SET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../rgb/rgb-set');
  const rgbManager = new RgbStateManager(RGB_SET);
  await rgbManager.reset();

  // Discord bot must be ready before worker starts — guild cache must be warm for activities
  const discordClient = createDiscordBot(config, temporalClient, rgbManager);
  await startDiscordBot(discordClient, config);

  // Start Temporal worker (runs indefinitely in background)
  const worker = await createWorker({ ollamaClient, discordClient, config, stateStore });
  void worker.run().catch((err) => {
    console.error('Temporal worker error:', err);
    process.exit(1);
  });

  // Register schedules (idempotent — safe on every restart)
  await registerSchedules(config, temporalClient);

  console.log('AI Hub running. Temporal schedules registered.');

  process.on('SIGTERM', () => {
    rgbManager.reset();
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
