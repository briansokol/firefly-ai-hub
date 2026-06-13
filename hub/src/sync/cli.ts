// Provisioning CLI for F3 multi-user. Run inside the compose network so it can
// reach postgresql:5432 and litellm:4000:
//   docker compose -f deploy/docker-compose.yml exec ai-hub node dist/sync/cli.js <cmd>
// Or in dev:  npm run provision -- <cmd>
//
// Commands:
//   user-add         --name "Brian" --profile adult|kid [--username brian]
//                    (--username also needs PROVISION_PASSWORD env var)
//   user-list
//   user-set-profile --user <uuid> --profile adult|kid
//   device-add       --user <uuid> --name "macbook"
import { createSyncStore } from './store.js';
import { provisionUser, provisionDevice, setUserProfile } from './provision.js';
import { hashPassword } from './auth.js';
import type { LitellmConfig } from './litellm.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} env var is required`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const store = await createSyncStore(requireEnv('SYNC_DB_URL'));
  try {
    if (cmd === 'user-add') {
      const litellm: LitellmConfig = {
        baseUrl: process.env.LITELLM_INTERNAL_URL ?? 'http://litellm:4000',
        masterKey: requireEnv('LITELLM_MASTER_KEY'),
      };
      const name = arg('--name');
      const profile = arg('--profile') ?? 'adult';
      if (!name) throw new Error('--name is required');
      // Optional login credentials. Password comes from PROVISION_PASSWORD (not a
      // flag) so it does not land in shell history.
      const username = arg('--username');
      let passwordHash: string | undefined;
      if (username) {
        const pw = process.env.PROVISION_PASSWORD;
        if (!pw) throw new Error('--username requires the PROVISION_PASSWORD env var');
        passwordHash = await hashPassword(pw);
      }
      const u = await provisionUser(store, litellm, {
        displayName: name,
        profile,
        ...(username ? { username, passwordHash } : {}),
      });
      console.log(JSON.stringify(u, null, 2));
    } else if (cmd === 'user-list') {
      const { rows } = await store.pool.query(
        'SELECT id, display_name, profile, (litellm_key IS NOT NULL) AS has_key FROM users ORDER BY created_at ASC',
      );
      console.table(rows);
    } else if (cmd === 'user-set-profile') {
      const litellm: LitellmConfig = {
        baseUrl: process.env.LITELLM_INTERNAL_URL ?? 'http://litellm:4000',
        masterKey: requireEnv('LITELLM_MASTER_KEY'),
      };
      const userId = arg('--user');
      const profile = arg('--profile');
      if (!userId || !profile) throw new Error('--user and --profile are required');
      const u = await setUserProfile(store, litellm, { userId, profile });
      console.log(JSON.stringify(u, null, 2));
    } else if (cmd === 'device-add') {
      const userId = arg('--user');
      const name = arg('--name');
      if (!userId || !name) throw new Error('--user and --name are required');
      const d = await provisionDevice(store, { userId, name });
      const litellmKey = await store.getUserLitellmKey(userId);
      console.log(JSON.stringify({ ...d, litellmKey }, null, 2));
    } else {
      console.error('usage: cli.js <user-add|user-list|user-set-profile|device-add> [flags]');
      process.exit(2);
    }
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
