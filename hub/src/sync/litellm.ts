// Minimal LiteLLM admin client (raw fetch — no extra dependency).
// Used by provisioning to mint a per-user virtual key with a model allow-list.

export const PROFILE_MODELS: Record<string, string[]> = {
  adult: ['fast', 'code', 'chat-heavy', 'frontier'],
  kid: ['fast', 'chat-heavy'],
};

export interface LitellmConfig {
  baseUrl: string;
  masterKey: string;
}

export interface KeySpec {
  models: string[];
  keyAlias?: string;
}

/** Create a LiteLLM virtual key scoped to `models`. Returns the new key string. */
export async function generateVirtualKey(cfg: LitellmConfig, spec: KeySpec): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/key/generate`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.masterKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      models: spec.models,
      ...(spec.keyAlias ? { key_alias: spec.keyAlias } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`litellm /key/generate failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { key?: string };
  if (!json.key) throw new Error('litellm /key/generate returned no key');
  return json.key;
}

/** Re-scope an existing LiteLLM virtual key to a new `models` allow-list, in place. */
export async function updateVirtualKey(
  cfg: LitellmConfig,
  spec: { key: string; models: string[] },
): Promise<void> {
  const res = await fetch(`${cfg.baseUrl}/key/update`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.masterKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ key: spec.key, models: spec.models }),
  });
  if (!res.ok) {
    throw new Error(`litellm /key/update failed: ${res.status} ${await res.text()}`);
  }
}
