import { query } from "./db";

export function getApiKey(providerId: string): string | null {
  const row = query(
    "SELECT api_key FROM provider_credentials WHERE provider_id = ?",
  ).get(providerId) as { api_key: string } | undefined;
  return row?.api_key ?? null;
}

export function hasApiKey(providerId: string): boolean {
  return getApiKey(providerId) !== null;
}

export function setApiKey(providerId: string, apiKey: string): void {
  query(
    `INSERT INTO provider_credentials (provider_id, api_key, updated_at)
     VALUES (?, ?, unixepoch())
     ON CONFLICT(provider_id) DO UPDATE SET
       api_key = excluded.api_key,
       updated_at = unixepoch()`,
  ).run(providerId, apiKey);
}

export function deleteApiKey(providerId: string): void {
  query("DELETE FROM provider_credentials WHERE provider_id = ?").run(
    providerId,
  );
}