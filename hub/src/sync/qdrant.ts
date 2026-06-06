// Minimal Qdrant REST client (raw fetch — no extra dependency).
// Used by the memory-distillation workflow and /memories/search.

export interface QdrantHit {
  id: string;
  score: number;
}

async function qreq(baseUrl: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Create the collection if it does not already exist. Idempotent. */
export async function ensureCollection(
  baseUrl: string,
  collection: string,
  dims: number,
): Promise<void> {
  const check = await qreq(baseUrl, 'GET', `/collections/${collection}`);
  if (check.ok) return;
  const res = await qreq(baseUrl, 'PUT', `/collections/${collection}`, {
    vectors: { size: dims, distance: 'Cosine' },
  });
  if (!res.ok) {
    throw new Error(`qdrant ensureCollection failed: ${res.status} ${await res.text()}`);
  }
}

/** Upsert a single point keyed by id (a UUID), with a vector and payload. */
export async function upsertPoint(
  baseUrl: string,
  collection: string,
  id: string,
  vector: number[],
  payload: Record<string, unknown>,
): Promise<void> {
  const res = await qreq(baseUrl, 'PUT', `/collections/${collection}/points`, {
    points: [{ id, vector, payload }],
  });
  if (!res.ok) {
    throw new Error(`qdrant upsert failed: ${res.status} ${await res.text()}`);
  }
}

/** Search top-k by vector, optionally filtered by a payload field equality. */
export async function search(
  baseUrl: string,
  collection: string,
  vector: number[],
  k: number,
  filterField?: { key: string; value: string },
): Promise<QdrantHit[]> {
  const body: Record<string, unknown> = { vector, limit: k, with_payload: false };
  if (filterField) {
    body.filter = { must: [{ key: filterField.key, match: { value: filterField.value } }] };
  }
  const res = await qreq(baseUrl, 'POST', `/collections/${collection}/points/search`, body);
  if (!res.ok) {
    throw new Error(`qdrant search failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { result: { id: string; score: number }[] };
  return json.result.map((r) => ({ id: String(r.id), score: r.score }));
}
