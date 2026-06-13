import { randomBytes, createHash } from 'node:crypto';
import type { SyncStore } from './store.js';
import {
  PROFILE_MODELS,
  generateVirtualKey,
  updateVirtualKey,
  type LitellmConfig,
} from './litellm.js';

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
  opts: { displayName: string; profile: string; username?: string; passwordHash?: string },
): Promise<ProvisionedUser> {
  const models = PROFILE_MODELS[opts.profile];
  if (!models) {
    throw new Error(
      `unknown profile '${opts.profile}' (expected: ${Object.keys(PROFILE_MODELS).join(', ')})`,
    );
  }
  const { userId } =
    opts.username && opts.passwordHash
      ? await store.createUserWithLogin(opts.displayName, opts.profile, opts.username, opts.passwordHash)
      : await store.createUser(opts.displayName, opts.profile);
  // Key alias must be unique (LiteLLM enforces it). Derive it from the userId,
  // not the display name — two users named "Brian" must not collide. If key
  // minting fails, roll back the just-created user so we never leave a
  // half-provisioned account (username taken, no usable key).
  try {
    const litellmKey = await generateVirtualKey(litellm, {
      models,
      keyAlias: `${opts.profile}-${userId}`.toLowerCase(),
    });
    await store.setUserLitellmKey(userId, litellmKey);
    return { userId, profile: opts.profile, litellmKey };
  } catch (err) {
    await store.deleteUser(userId);
    throw err;
  }
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

/**
 * Change an existing user's profile and re-scope its LiteLLM key's model
 * allow-list to match. The key string is preserved (updated in place), so the
 * user's devices keep working with their stored key — they just gain/lose
 * access to the profile's models. Affects all of the user's devices at once.
 */
export async function setUserProfile(
  store: SyncStore,
  litellm: LitellmConfig,
  opts: { userId: string; profile: string },
): Promise<ProvisionedUser> {
  const models = PROFILE_MODELS[opts.profile];
  if (!models) {
    throw new Error(
      `unknown profile '${opts.profile}' (expected: ${Object.keys(PROFILE_MODELS).join(', ')})`,
    );
  }
  const user = await store.getUser(opts.userId);
  if (!user) {
    throw new Error(`unknown user '${opts.userId}'`);
  }
  let litellmKey = user.litellmKey;
  if (litellmKey) {
    await updateVirtualKey(litellm, { key: litellmKey, models });
  } else {
    litellmKey = await generateVirtualKey(litellm, {
      models,
      keyAlias: `${opts.profile}-${opts.userId}`.toLowerCase(),
    });
    await store.setUserLitellmKey(opts.userId, litellmKey);
  }
  await store.setUserProfile(opts.userId, opts.profile);
  return { userId: opts.userId, profile: opts.profile, litellmKey };
}
