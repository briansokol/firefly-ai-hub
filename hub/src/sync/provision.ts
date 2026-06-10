import { randomBytes, createHash } from 'node:crypto';
import type { SyncStore } from './store.js';
import { PROFILE_MODELS, generateVirtualKey, type LitellmConfig } from './litellm.js';

/** Generate a fresh device bearer token (the plaintext shown to the operator once). */
export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex hash of a token — only the hash is stored in Postgres. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface ProvisionedUser {
  userId: string;
  profile: string;
  litellmKey: string;
}

/** Create a user, mint its LiteLLM virtual key for the profile, persist the key. */
export async function provisionUser(
  store: SyncStore,
  litellm: LitellmConfig,
  opts: { displayName: string; profile: string },
): Promise<ProvisionedUser> {
  const models = PROFILE_MODELS[opts.profile];
  if (!models) {
    throw new Error(
      `unknown profile '${opts.profile}' (expected: ${Object.keys(PROFILE_MODELS).join(', ')})`,
    );
  }
  const { userId } = await store.createUser(opts.displayName, opts.profile);
  const litellmKey = await generateVirtualKey(litellm, {
    models,
    keyAlias: `${opts.profile}-${opts.displayName}`.toLowerCase().replace(/\s+/g, '-'),
  });
  await store.setUserLitellmKey(userId, litellmKey);
  return { userId, profile: opts.profile, litellmKey };
}

export interface ProvisionedDevice {
  deviceId: string;
  deviceToken: string;
}

/** Create a device for a user and mint+store its token. Returns the plaintext token. */
export async function provisionDevice(
  store: SyncStore,
  opts: { userId: string; name: string },
): Promise<ProvisionedDevice> {
  const deviceToken = mintToken();
  const { deviceId } = await store.createDevice(opts.userId, opts.name, hashToken(deviceToken));
  return { deviceId, deviceToken };
}
