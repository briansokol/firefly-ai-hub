import { ImapFlow } from 'imapflow';
import type { SearchObject } from 'imapflow';
import type { EmailAccount } from '../types.js';

export interface FetchedEmail {
  uid: number;
  subject: string;
  from: string;
  date: Date;
  text: string;
}

export async function fetchNewEmails(
  account: EmailAccount,
  password: string,
  lastUid: number,
  limit?: number,
): Promise<FetchedEmail[]> {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.ssl,
    auth: { user: account.username, pass: password },
    logger: false,
  });

  await client.connect();
  const results: FetchedEmail[] = [];

  try {
    // On first run (lastUid = 0), scope to last 2 days to avoid fetching all history
    const searchCriteria: SearchObject = { uid: `${lastUid + 1}:*` };
    if (lastUid === 0) {
      const since = new Date();
      since.setDate(since.getDate() - 2);
      searchCriteria.since = since;
    }

    for (const folder of account.folders) {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const uids = await client.search(searchCriteria, { uid: true });
        if (!uids || uids.length === 0) continue;

        for await (const msg of client.fetch(
          uids,
          {
            uid: true,
            envelope: true,
            bodyParts: [{ key: 'TEXT', maxLength: 5000 }],
          },
          { uid: true },
        )) {
          const env = msg.envelope;
          const addr = env?.from?.[0];
          const from = addr
            ? addr.name
              ? `${addr.name} <${addr.address}>`
              : (addr.address ?? 'unknown')
            : 'unknown';

          results.push({
            uid: msg.uid,
            subject: env?.subject ?? '(no subject)',
            from,
            date: env?.date ?? new Date(),
            text: msg.bodyParts?.get('TEXT')?.toString('utf8') ?? '',
          });
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout();
  }

  results.sort((a, b) => a.uid - b.uid);
  if (limit && limit > 0) {
    return results.slice(0, limit);
  }
  return results;
}

export interface MoveResult {
  uid: number;
  success: boolean;
}

export async function moveEmails(
  account: EmailAccount,
  password: string,
  sourceFolder: string,
  moves: Array<{ uid: number; destFolder: string }>,
): Promise<MoveResult[]> {
  if (moves.length === 0) return [];

  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.ssl,
    auth: { user: account.username, pass: password },
    logger: false,
  });

  await client.connect();
  const results: MoveResult[] = [];

  try {
    const lock = await client.getMailboxLock(sourceFolder, { readOnly: false });
    try {
      // Group UIDs by destination folder for efficient batch moves
      const groups = new Map<string, number[]>();
      for (const move of moves) {
        const existing = groups.get(move.destFolder) ?? [];
        existing.push(move.uid);
        groups.set(move.destFolder, existing);
      }

      for (const [destFolder, uids] of groups) {
        const uidSet = uids.join(',');
        try {
          await client.messageMove(uidSet, destFolder, { uid: true });
          for (const uid of uids) {
            results.push({ uid, success: true });
          }
        } catch (err) {
          console.error(`[moveEmails] Failed to move UIDs ${uidSet} to ${destFolder}:`, err);
          for (const uid of uids) {
            results.push({ uid, success: false });
          }
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return results;
}
