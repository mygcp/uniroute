import { getTableVersion, onDbReset, query } from "./db";

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

let cachedVersion = -1;
const keysByProvider = new Map<string, ApiKeyRow[]>();

onDbReset(() => {
  cachedVersion = -1;
  keysByProvider.clear();
});

function ensureFresh(): void {
  const ver = getTableVersion("provider_credentials");
  if (ver !== cachedVersion) {
    keysByProvider.clear();
    cachedVersion = ver;
  }
}

export function listApiKeys(providerId: string): ApiKeyRow[] {
  ensureFresh();
  const cached = keysByProvider.get(providerId);
  if (cached) return cached;
  const rows = query(
    `SELECT id, provider_id, label, api_key, proxy_pool_id, is_active, is_routing, created_at, updated_at
      FROM provider_credentials WHERE provider_id = ? ORDER BY id`,
  ).all(providerId) as unknown as ApiKeyRow[];
  keysByProvider.set(providerId, rows);
  return rows;
}

export function getApiKeyRow(providerId: string): ApiKeyRow | null {
  const active = listApiKeys(providerId).filter((k) => k.is_active === 1);
  if (active.length === 0) return null;
  return active.find((k) => k.is_routing === 1) ?? active[0];
}

export function getApiKey(providerId: string): string | null {
  return getApiKeyRow(providerId)?.api_key ?? null;
}

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

export function setApiKeyProxyPool(id: number, poolId: number | null): void {
  query(
    "UPDATE provider_credentials SET proxy_pool_id = ?, updated_at = unixepoch() WHERE id = ?",
  ).run(poolId, id);
}

export function getRoutingPoolId(
  providerId: string,
): number | undefined {
  const row = getApiKeyRow(providerId);
  return row ? (row.proxy_pool_id ?? undefined) : undefined;
}
