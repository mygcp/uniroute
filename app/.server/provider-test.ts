import { query } from "./db";
import { listApiKeys } from "./credential";
import { getRegistryEntry } from "~/registry";

export type ProviderTestResult = {
  ok: boolean;
  connected: number;
  total: number;
  detail?: string;
};

/**
 * Tes konektivitas satu provider: hitung berapa API key aktif yang berhasil
 * mengakses endpoint models upstream (timeout 5s per key).
 */
export async function testProviderConnection(
  providerId: string,
): Promise<ProviderTestResult> {
  const provider = query(
    "SELECT base_url, auth_type FROM providers WHERE id = ?",
  ).get(providerId) as { base_url: string; auth_type: string } | undefined;
  if (!provider) {
    return { ok: false, connected: 0, total: 0, detail: "Provider not found" };
  }

  const keys = listApiKeys(providerId).filter((k) => k.is_active);
  if (keys.length === 0 && provider.auth_type !== "none") {
    return { ok: false, connected: 0, total: 0, detail: "No active API keys" };
  }

  const entry = getRegistryEntry(providerId);
  const modelsUrl =
    entry?.modelsUrl ?? new URL("/v1/models", provider.base_url).toString();

  let connected = 0;
  const tested = keys.length > 0 ? keys : [null];

  for (const key of tested) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const headers = new Headers({ "Content-Type": "application/json" });
      if (key) {
        if (provider.auth_type === "bearer") {
          headers.set("Authorization", `Bearer ${key.api_key}`);
        } else if (provider.auth_type === "apikey") {
          headers.set("x-goog-api-key", key.api_key);
        }
      }
      if (entry?.headers) {
        for (const [k, v] of Object.entries(entry.headers)) headers.set(k, v);
      }
      const res = await fetch(modelsUrl, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) connected += 1;
    } catch {
      /* koneksi gagal untuk key ini */
    }
  }

  return {
    ok: connected > 0,
    connected,
    total: tested.length,
    detail: connected === 0 ? "All keys failed" : undefined,
  };
}
