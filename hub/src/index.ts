import { Connection, Client as TemporalClient } from '@temporalio/client';
import { loadConfig } from './config.js';
import { createDiscordBot, startDiscordBot } from './discord/bot.js';

async function main() {
  const config = loadConfig();
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const connection = await Connection.connect({ address });
  const temporalClient = new TemporalClient({ connection });
  const discordClient = createDiscordBot(config, temporalClient);
  await startDiscordBot(discordClient, config);
  console.log('AI Hub running.');
}

main().catch((err) => { console.error('Fatal error:', err); process.exit(1); });
