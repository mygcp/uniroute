import { query } from "./db";

export type ApiKeyRow = {
  id: number;
  provider_id: string;
  label: string | null;
  api_key: string;
  proxy_pool_id: number | null;
  is_active: number;
  is_routing: number;
  created_at: number;
  updated_at: number;
};

export function listApiKeys(providerId: string): ApiKeyRow[] {
  return query(
    `SELECT id, provider_id, label, api_key, proxy_pool_id, is_active, is_routing, created_at, updated_at
      FROM provider_credentials WHERE provider_id = ? ORDER BY id`,
  ).all(providerId) as unknown as ApiKeyRow[];
}

/** Ambil api_key yang sedang dipakai untuk routing (is_routing=1, aktif). */
export function getApiKey(providerId: string): string | null {
  const row = query(
    "SELECT api_key FROM provider_credentials WHERE provider_id = ? AND is_routing = 1 AND is_active = 1 ORDER BY id LIMIT 1",
  ).get(providerId) as { api_key: string } | undefined;
  if (row) return row.api_key;
  const fallback = query(
    "SELECT api_key FROM provider_credentials WHERE provider_id = ? AND is_active = 1 ORDER BY id LIMIT 1",
  ).get(providerId) as { api_key: string } | undefined;
  return fallback?.api_key ?? null;
}

export function hasApiKey(providerId: string): boolean {
  const row = query(
    "SELECT 1 as x FROM provider_credentials WHERE provider_id = ? LIMIT 1",
  ).get(providerId) as { x: number } | undefined;
  return !!row;
}

/** Tambah API key baru (multi account). Optionally becomes the routing key. */
export function addApiKey(
  providerId: string,
  apiKey: string,
  label: string | null,
  makeRouting: boolean,
): void {
  if (makeRouting) {
    query(
      "UPDATE provider_credentials SET is_routing = 0 WHERE provider_id = ?",
    ).run(providerId);
  }
  query(
    `INSERT INTO provider_credentials (provider_id, label, api_key, is_active, is_routing, updated_at)
     VALUES (?, ?, ?, 1, ?, unixepoch())`,
  ).run(providerId, label, apiKey, makeRouting ? 1 : 0);
}

/** Legacacy upsert: set/replace the routing key for a provider. */
export function setApiKey(providerId: string, apiKey: string): void {
  const existing = query(
    "SELECT id FROM provider_credentials WHERE provider_id = ? AND is_routing = 1 LIMIT 1",
  ).get(providerId) as { id: number } | undefined;
  if (existing) {
    query(
      "UPDATE provider_credentials SET api_key = ?, updated_at = unixepoch() WHERE id = ?",
    ).run(apiKey, existing.id);
  } else {
    addApiKey(providerId, apiKey, null, true);
  }
}

export function deleteApiKeyById(id: number): void {
  query("DELETE FROM provider_credentials WHERE id = ?").run(id);
}

/** Legacy helper — deletes ALL keys for a provider. */
export function deleteApiKey(providerId: string): void {
  query("DELETE FROM provider_credentials WHERE provider_id = ?").run(
    providerId,
  );
}

export function setRoutingKey(id: number): void {
  const row = query(
    "SELECT provider_id FROM provider_credentials WHERE id = ?",
  ).get(id) as { provider_id: string } | undefined;
  if (!row) return;
  query(
    "UPDATE provider_credentials SET is_routing = 0 WHERE provider_id = ?",
  ).run(row.provider_id);
  query(
    "UPDATE provider_credentials SET is_routing = 1 WHERE id = ?",
  ).run(id);
}

export function setApiKeyActive(id: number, active: boolean): void {
  query(
    "UPDATE provider_credentials SET is_active = ?, updated_at = unixepoch() WHERE id = ?",
  ).run(active ? 1 : 0, id);
}

export function getRoutingCredential(
  providerId: string,
): { api_key: string } | null {
  const row = query(
    "SELECT api_key FROM provider_credentials WHERE provider_id = ? AND is_routing = 1 AND is_active = 1 ORDER BY id LIMIT 1",
  ).get(providerId) as { api_key: string } | undefined;
  if (row) return row;
  const fallback = query(
    "SELECT api_key FROM provider_credentials WHERE provider_id = ? AND is_active = 1 ORDER BY id LIMIT 1",
  ).get(providerId) as { api_key: string } | undefined;
  return fallback ?? null;
}

/** Set proxy pool assigned to one provider credential (API key). Null clears it. */
export function setApiKeyProxyPool(id: number, poolId: number | null): void {
  query(
    "UPDATE provider_credentials SET proxy_pool_id = ?, updated_at = unixepoch() WHERE id = ?",
  ).run(poolId, id);
}

/** Full row of the credential getApiKey() would resolve (routing, else first active). */
export function getApiKeyRow(providerId: string): ApiKeyRow | null {
  const cols =
    "id, provider_id, label, api_key, proxy_pool_id, is_active, is_routing, created_at, updated_at";
  const routing = query(
    `SELECT ${cols} FROM provider_credentials WHERE provider_id = ? AND is_routing = 1 AND is_active = 1 ORDER BY id LIMIT 1`,
  ).get(providerId) as ApiKeyRow | undefined;
  if (routing) return routing;
  const fallback = query(
    `SELECT ${cols} FROM provider_credentials WHERE provider_id = ? AND is_active = 1 ORDER BY id LIMIT 1`,
  ).get(providerId) as ApiKeyRow | undefined;
  return fallback ?? null;
}
