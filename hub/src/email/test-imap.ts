/**
 * Standalone IMAP connectivity test for Fastmail.
 * Usage: npx tsx hub/src/email/test-imap.ts
 */
import { ImapFlow } from 'imapflow';
import { loadConfig, getEmailPassword } from '../config.js';

async function main() {
  const config = loadConfig();
  const account = config.email.accounts.find((a) => a.name === 'fastmail');
  if (!account) {
    console.error('No "fastmail" account found in config');
    process.exit(1);
  }

  const password = getEmailPassword(account);
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.ssl,
    auth: { user: account.username, pass: password },
    logger: false,
  });

  console.log(`Connecting to ${account.host}:${account.port} as ${account.username}...`);
  await client.connect();
  console.log('Connected!\n');

  // List all mailboxes, filter to Screening*
  const mailboxes = await client.list();
  const screeningBoxes = mailboxes.filter((m) => m.path.startsWith('Screening'));
  console.log('Screening folders:');
  for (const mb of screeningBoxes) {
    console.log(`  ${mb.path}  (delimiter: "${mb.delimiter}")`);
  }
  if (screeningBoxes.length === 0) {
    console.log('  (none found — check folder names)');
  }
  console.log();

  // Open Screening and report message count
  const lock = await client.getMailboxLock('Screening', { readOnly: true });
  try {
    const status = client.mailbox;
    if (!status) {
      console.log('Screening mailbox: could not read status');
    } else {
      console.log(`Screening mailbox: ${status.exists} messages, uidNext=${status.uidNext}`);
    }
    console.log();

    // Fetch 3 most recent messages
    if (status && status.exists > 0) {
      const startSeq = Math.max(1, status.exists - 2);
      console.log(`Recent messages (seq ${startSeq}:*):`);
      for await (const msg of client.fetch(`${startSeq}:*`, {
        uid: true,
        envelope: true,
      })) {
        const env = msg.envelope;
        const addr = env?.from?.[0];
        const from = addr?.name ?? addr?.address ?? 'unknown';
        console.log(`  UID ${msg.uid}: "${env?.subject ?? '(no subject)'}" from ${from}`);
      }
    }
  } finally {
    lock.release();
  }

  await client.logout();
  console.log('\nDone — connectivity test passed.');
}

main().catch((err) => {
  console.error('Connectivity test FAILED:', err);
  process.exit(1);
});
