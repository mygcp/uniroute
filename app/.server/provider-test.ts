import { createLimiter, singleflight, TtlCache } from "./async-utils";
import { onDbReset, query } from "./db";
import { listApiKeys } from "./credential";
import { getRegistryEntry } from "~/registry";
import { joinApiUrl } from "./adapter";
import { assertSafeUrl } from "./ssrf";

export type ProviderTestResult = {
  ok: boolean;
  connected: number;
  total: number;
  detail?: string;
};

const keyTestLimiter = createLimiter(5);
const testResultCache = new TtlCache<string, ProviderTestResult>(200, 15_000);
onDbReset(() => testResultCache.clear());

export function testProviderConnection(
  providerId: string,
): Promise<ProviderTestResult> {
  const cached = testResultCache.get(providerId);
  if (cached) return Promise.resolve(cached);

  return singleflight(`provider-test:${providerId}`, async () => {
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
      entry?.modelsUrl ?? joinApiUrl(provider.base_url, "/v1/models");

    try {
      await assertSafeUrl(modelsUrl, { allowPrivate: true, allowLoopback: true });
    } catch (err) {
      return {
        ok: false,
        connected: 0,
        total: keys.length || 1,
        detail: err instanceof Error ? err.message : "Invalid provider URL",
      };
    }

    const tested = keys.length > 0 ? keys : [null];
    const results = await Promise.all(
      tested.map((key) =>
        keyTestLimiter(async () => {
          try {
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
              redirect: "manual",
              signal: AbortSignal.timeout(5000),
            });
            return res.ok;
          } catch {
            return false;
          }
        }),
      ),
    );

    const connected = results.filter(Boolean).length;
    const out: ProviderTestResult = {
      ok: connected > 0,
      connected,
      total: tested.length,
      detail: connected === 0 ? "All keys failed" : undefined,
    };
    testResultCache.set(providerId, out);
    return out;
  });
}
