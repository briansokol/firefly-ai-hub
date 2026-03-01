import { loadConfig } from './config.js';

async function main() {
  const config = loadConfig();
  console.log('AI Hub starting...');
}

main().catch((err) => { console.error('Fatal error:', err); process.exit(1); });
