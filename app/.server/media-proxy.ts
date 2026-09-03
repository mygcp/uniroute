import { isValid, getSessionToken } from "./auth";
import {
  isRequireApiKey,
  resolveClientKey,
} from "./client-key";
import { getApiKey } from "./credential";
import {
  beginConnection,
  endConnection,
  markUsed,
  selectProvider,
} from "./balancer";
import { fetchUpstream } from "./proxy-resolver";
import { getProviders, type Provider } from "./registry";
import { getRegistryEntry } from "~/registry";
import { resolveDisplayToBare, unavailableReason } from "./provider-prefix";
import { recordRequestLog } from "./logger";
import { broadcast } from "./log-stream";
import { clientIpFromRequest } from "./key-enforce";

/**
 * Media passthrough — endpoint non-chat (image gen / TTS / STT) diteruskan
 * apa adanya ke provider, memakai mesin routing yang sama: auth, kredensial
 * routing key, proxy pool, request log & realtime broadcast.
 */

export type MediaKind =
  | "images-generations"
  | "audio-speech"
  | "audio-transcriptions";

const MEDIA_PATHS: Record<MediaKind, string> = {
  "images-generations": "/v1/images/generations",
  "audio-speech": "/v1/audio/speech",
  "audio-transcriptions": "/v1/audio/transcriptions",
};

function buildMediaUrl(
  baseUrl: string,
  urlSuffix: string | undefined,
  kind: MediaKind,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (urlSuffix && !urlSuffix.includes("chat")) {
    // Registry entry dengan suffix khusus (bukan chat) dipakai sebagai path.
    return `${base}/${urlSuffix.replace(/^\/+/, "")}`;
  }
  return `${base}${MEDIA_PATHS[kind]}`;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildAuthHeaders(
  provider: Provider,
  entry: ReturnType<typeof getRegistryEntry>,
): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  const key = getApiKey(provider.id);
  const usedKey = key ?? null;
  if (entry?.authHeader) {
    if (usedKey) {
      headers.set(entry.authHeader, `${entry.authPrefix ?? ""} ${usedKey}`.trim());
    }
  } else if (provider.auth_type === "bearer") {
    if (usedKey) headers.set("Authorization", `Bearer ${usedKey}`);
  } else if (provider.auth_type === "apikey") {
    if (usedKey) headers.set("x-goog-api-key", usedKey);
  }
  if (entry?.headers) {
    for (const [k, v] of Object.entries(entry.headers)) headers.set(k, v);
  }
  return headers;
}

/** Auth ringkas: session dashboard ATAU bearer client API key. */
function authorizeMedia(request: Request): string | null {
  if (isValid(getSessionToken(request))) return null;
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : null;
  if (!token) {
    return isRequireApiKey() ? "api key required" : null;
  }
  const resolved = resolveClientKey(token);
  return resolved.ok ? null : resolved.message;
}

/** Ambil `model` dari body JSON maupun multipart form. */
async function extractModel(request: Request): Promise<{
  model: string;
  body: BodyInit;
  contentType: string;
}> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const buf = await request.arrayBuffer();
    let model = "";
    try {
      const fd2 = await new Request(request.url, {
        method: "POST",
        body: buf,
        headers: { "Content-Type": contentType },
      }).formData();
      const m = fd2.get("model");
      if (typeof m === "string") model = m;
    } catch {
      /* ignore */
    }
    return { model, body: buf, contentType };
  }
  const text = await request.text();
  let model = "";
  try {
    model = String((JSON.parse(text) as Record<string, unknown>).model ?? "");
  } catch {
    /* biarkan kosong; nanti 404 dengan pesan jelas */
  }
  return { model, body: text, contentType: contentType || "application/json" };
}

export async function handleMediaRequest(
  request: Request,
  kind: MediaKind,
): Promise<Response> {
  const started = Date.now();

  const authError = authorizeMedia(request);
  if (authError) {
    recordRequestLog({
      model: kind,
      provider_id: "guard",
      status: "denied",
      error_message: authError,
      endpoint: kind,
    });
    return json({ error: { message: authError } }, 401);
  }

  const clientIp = clientIpFromRequest(request);

  // api_key_id client (bila pakai bearer client key).
  let clientApiKeyId: number | null = null;
  {
    const header = request.headers.get("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    const token = match ? match[1].trim() : null;
    if (token && !isValid(getSessionToken(request))) {
      const r = resolveClientKey(token);
      if (r.ok) clientApiKeyId = r.key.id;
    }
  }

  const { model: rawModel, body, contentType } = await extractModel(request);
  const _prefixInfoMedia = rawModel ? resolveDisplayToBare(rawModel) : null;
  const model = _prefixInfoMedia ? _prefixInfoMedia.bare : rawModel;
  let pool = model ? getProviders(model) : [];
  if (_prefixInfoMedia?.providerId) {
    const hinted = pool.filter((p) => p.id === _prefixInfoMedia.providerId);
    if (hinted.length > 0) pool = hinted;
  }

  if (pool.length === 0) {
    const reason = rawModel ? unavailableReason(rawModel) : null;
    if (reason?.kind === "provider_disabled") {
      return json(
        {
          error: {
            message: `model '${rawModel}' is unavailable: provider '${reason.providerName}' is disabled`,
            type: "provider_disabled",
            model: rawModel,
            provider: reason.providerId,
          },
        },
        404,
      );
    }
    if (reason?.kind === "model_disabled") {
      return json(
        {
          error: {
            message: `model '${rawModel}' is disabled`,
            type: "model_disabled",
            model: rawModel,
            provider: reason.providerId,
          },
        },
        404,
      );
    }
    return json(
      {
        error: {
          message:
            `No provider has model '${model || "(empty)"}'. ` +
            `Add this ${kind.replace("-", " ")} model under a provider to route it.`,
          type: "model_not_found",
        },
      },
      404,
    );
  }

  const selected = selectProvider(pool, model) ?? pool[0];
  const candidates: Provider[] = [selected];
  {
    const alt = pool.find((p) => p.id !== selected.id);
    if (alt) candidates.push(alt);
  }

  const reqStartId = `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
  let lastStatus = 502;

  for (let attempt = 0; attempt < candidates.length; attempt++) {
    const provider = candidates[attempt]!;
    beginConnection(provider.id);
    const entry = getRegistryEntry(provider.id);
    const url = buildMediaUrl(provider.base_url, entry?.urlSuffix, kind);
    const headers = buildAuthHeaders(provider, entry);

    broadcast({
      type: "request-start",
      reqId: `${reqStartId}-${attempt}`,
      model: model || kind,
      provider_id: provider.id,
      endpoint: kind,
      client_ip: clientIp,
      api_key_id: clientApiKeyId,
      started_at: Date.now(),
    });

    let usedProxyId: number | null = null;
    const onProxyUsed = (proxyId: number | null): void => {
      if (proxyId != null) usedProxyId = proxyId;
    };

    let resp: Response;
    try {
      resp = await fetchUpstream(url, {
        method: "POST",
        headers,
        body,
        providerPoolId: undefined,
        providerId: provider.id,
        onProxyUsed: (resolved) => onProxyUsed(resolved.proxy.id),
        logClientIp: clientIp,
        logApiKeyId: clientApiKeyId,
      });
    } catch (err) {
      endConnection(provider.id);
      broadcast({ type: "request-end", reqId: `${reqStartId}-${attempt}` });
      recordRequestLog({
        model: model || kind,
        provider_id: provider.id,
        duration_ms: Date.now() - started,
        status: "error",
        error_message:
          err instanceof Error ? err.message : String(err),
        endpoint: kind,
        via_proxy: usedProxyId != null ? 1 : 0,
        proxy_id: usedProxyId,
      });
      lastStatus = 502;
      continue;
    }

    const durationMs = Date.now() - started;
    endConnection(provider.id);
    markUsed(provider);
    broadcast({ type: "request-end", reqId: `${reqStartId}-${attempt}` });
    recordRequestLog({
      model: model || kind,
      provider_id: provider.id,
      duration_ms: durationMs,
      status: resp.ok ? "success" : "error",
      error_message: resp.ok ? null : `HTTP ${resp.status}`,
      endpoint: kind,
      via_proxy: usedProxyId != null ? 1 : 0,
      proxy_id: usedProxyId,
      api_key_id: clientApiKeyId,
    });

    if (resp.ok) {
      const passthroughCT =
        resp.headers.get("content-type") ??
        (kind === "images-generations" ? "application/json" : "application/octet-stream");
      return new Response(resp.body, {
        status: resp.status,
        headers: { "Content-Type": passthroughCT },
      });
    }

    lastStatus = resp.status;
  }

  return json(
    { error: { message: `media request failed (HTTP ${lastStatus})` } },
    lastStatus,
  );
}

