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
