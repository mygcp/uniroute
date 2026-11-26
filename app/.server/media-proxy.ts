import { isValid, getSessionToken } from "./auth";
import {
  isRequireApiKey,
  modelAllowed,
  modelBlocked,
  providerAllowed,
  providerBlocked,
  resolveClientKey,
  type ClientKey,
} from "./client-key";
import { getApiKey } from "./credential";
import {
  beginConnection,
  endConnection,
  markUsed,
  selectProvider,
} from "./balancer";
import { checkAllowlist } from "./guard";
import { fetchUpstream } from "./proxy-resolver";
import { getProviders, type Provider } from "./registry";
import { getRegistryEntry } from "~/registry";
import { resolveDisplayToBare, unavailableReason } from "./provider-prefix";
import { evaluateTextPromptGuard, getPromptGuardSettings } from "./prompt-guard";
import { recordProxyLog, recordRequestLog } from "./logger";
import { broadcast } from "./log-stream";
import { evaluateRules } from "./rules";
import {
  acquireConcurrency,
  checkAccessHours,
  checkBudgetQuota,
  checkGroups,
  checkIp,
  checkRate,
  checkScope,
  clientIpFromRequest,
  isKeyExpired,
  releaseConcurrency,
} from "./key-enforce";
import { autoBlockKey, maybeRotateForInterval, recordRequestUsage } from "./key-ops";

export type MediaKind =
  | "images-generations"
  | "audio-speech"
  | "audio-transcriptions";

const MEDIA_PATHS: Record<MediaKind, string> = {
  "images-generations": "/v1/images/generations",
  "audio-speech": "/v1/audio/speech",
  "audio-transcriptions": "/v1/audio/transcriptions",
};

const MAX_MEDIA_BYTES = 26 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 120_000;
const SAFE_MEDIA_CT_PREFIXES = ["audio/", "image/", "application/json", "application/octet-stream"];

function buildMediaUrl(
  baseUrl: string,
  urlSuffix: string | undefined,
  kind: MediaKind,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (urlSuffix && !urlSuffix.includes("chat")) {
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

function safeMediaContentType(raw: string | null, kind: MediaKind): string {
  if (raw) {
    const lower = raw.split(";")[0]?.trim().toLowerCase() ?? "";
    if (SAFE_MEDIA_CT_PREFIXES.some((p) => lower.startsWith(p))) {
      return raw;
    }
  }
  return kind === "images-generations" ? "application/json" : "application/octet-stream";
}

function buildAuthHeaders(
  provider: Provider,
  entry: ReturnType<typeof getRegistryEntry>,
  contentType: string,
): Headers {
  const headers = new Headers({ "Content-Type": contentType || "application/json" });
  const usedKey = provider.auth_type === "none" ? null : (getApiKey(provider.id) ?? null);
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

type MediaAuthResult =
  | { ok: true; rule: ClientKey | null }
  | { ok: false; status: number; error: string };

function extractApiToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  const xKey = request.headers.get("x-api-key")?.trim();
  return xKey || null;
}

function authorizeMedia(request: Request): MediaAuthResult {
  if (isValid(getSessionToken(request))) {
    return { ok: true, rule: null };
  }
  const token = extractApiToken(request);
  if (!token) {
    return isRequireApiKey()
      ? { ok: false, status: 401, error: "api key required" }
      : { ok: true, rule: null };
  }
  const resolved = resolveClientKey(token);
  if (!resolved.ok) {
    return { ok: false, status: resolved.status, error: resolved.message };
  }
  const key = resolved.key;
  maybeRotateForInterval(key);
  if (isKeyExpired(key)) return { ok: false, status: 403, error: "api key expired" };

  const ipCheck = checkIp(key, clientIpFromRequest(request));
  if (!ipCheck.ok) return ipCheck;

  const hoursCheck = checkAccessHours(key);
  if (!hoursCheck.ok) return hoursCheck;

  const scopeCheck = checkScope(key, "media");
  if (!scopeCheck.ok) return scopeCheck;

  const budgetCheck = checkBudgetQuota(key);
  if (!budgetCheck.ok) {
    if (key.auto_block === 1 && !key.blocked_at) {
      autoBlockKey(key.id, budgetCheck.reason ?? "budget exceeded");
    }
    return { ok: false, status: 429, error: budgetCheck.reason ?? "budget exceeded" };
  }

  const groupCheck = checkGroups(key);
  if (!groupCheck.ok) return groupCheck;

  const rateCheck = checkRate(key, 100);
  if (!rateCheck.allowed) {
    return { ok: false, status: 429, error: "rate limit exceeded" };
  }

  return { ok: true, rule: key };
}

function scanMultipartModel(buf: ArrayBuffer): string {
  const sliceLen = Math.min(buf.byteLength, 16 * 1024);
  const head = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(buf, 0, sliceLen));
  const match = head.match(/name="model"\r\n\r\n([^\r\n]{1,200})\r\n/);
  return match ? match[1].trim() : "";
}

async function extractModelAndBody(request: Request): Promise<{
  tooLarge?: boolean;
  model: string;
  promptText: string;
  body: BodyInit;
  contentType: string;
}> {
  const cl = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(cl) && cl > MAX_MEDIA_BYTES) {
    return { tooLarge: true, model: "", promptText: "", body: "", contentType: "application/json" };
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_MEDIA_BYTES) {
      return { tooLarge: true, model: "", promptText: "", body: "", contentType };
    }
    let model = scanMultipartModel(buf);
    if (!model) {
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
    }
    return { model, promptText: "", body: buf, contentType };
  }

  const text = await request.text();
  if (text.length > MAX_MEDIA_BYTES) {
    return { tooLarge: true, model: "", promptText: "", body: "", contentType: "application/json" };
  }
  let model = "";
  let promptText = "";
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    model = String(parsed.model ?? "");
    if (typeof parsed.prompt === "string") promptText = parsed.prompt;
    else if (typeof parsed.input === "string") promptText = parsed.input;
  } catch {
    /* ignore */
  }
  return { model, promptText, body: text, contentType: contentType || "application/json" };
}

export async function handleMediaRequest(
  request: Request,
  kind: MediaKind,
): Promise<Response> {
  const started = Date.now();
  const clientIp = clientIpFromRequest(request);

  const auth = authorizeMedia(request);
  if (!auth.ok) {
    recordRequestLog({
      model: kind,
      provider_id: "guard",
      status: "denied",
      error_message: auth.error,
      endpoint: kind,
    });
    return json({ error: { message: auth.error } }, auth.status);
  }

  const rule = auth.rule;
  const clientApiKeyId = rule?.id ?? null;

  let concurrentScope: string | null = null;
  if (rule) {
    const conc = acquireConcurrency(rule);
    if (!conc.ok) {
      return json({ error: { message: "too many concurrent requests" } }, 429);
    }
    concurrentScope = conc.scope;
  }

  try {
    const extracted = await extractModelAndBody(request);
    if (extracted.tooLarge) {
      return json({ error: { message: "request payload too large" } }, 413);
    }

    const { model: rawModel, promptText, body, contentType } = extracted;
    const _prefixInfoMedia = rawModel ? resolveDisplayToBare(rawModel) : null;
    let model = _prefixInfoMedia ? _prefixInfoMedia.bare : rawModel;

    if (rule) {
      if (
        (rawModel && !modelAllowed(rule, rawModel) && !modelAllowed(rule, model)) ||
        modelBlocked(rule, rawModel) ||
        modelBlocked(rule, model)
      ) {
        return json({ error: { message: "model not allowed by api key" } }, 403);
      }
      if (rule.model_override) {
        model = rule.model_override;
      }
    }

    if (model) {
      const allowRes = checkAllowlist(model);
      if (!allowRes.ok) {
        return json({ error: { message: allowRes.reason, type: "model_denied" } }, 403);
      }
      const routeRule = evaluateRules(model);
      if (routeRule.action === "deny") {
        return json({ error: { message: "model denied by routing rule" } }, 403);
      }
      if (routeRule.action === "rewrite") {
        model = routeRule.targetModel;
        if (rule && (!modelAllowed(rule, model) || modelBlocked(rule, model))) {
          return json({ error: { message: "model not allowed by api key" } }, 403);
        }
      }
    }

    if (promptText && getPromptGuardSettings().check_media) {
      const pg = evaluateTextPromptGuard(promptText);
      if (pg.matches.length > 0) {
        recordProxyLog({
          level: "warn",
          source: "prompt-guard",
          message: `${pg.blocked ? "blocked" : "flagged"}: ${pg.reason ?? "policy match"}`,
          client_ip: clientIp,
          api_key_id: clientApiKeyId,
          endpoint: kind,
        });
      }
      if (pg.blocked) {
        recordRequestLog({
          model: model || kind,
          provider_id: "guard",
          status: "denied",
          rule_applied: `prompt-guard:${pg.reason ?? "matched"}`,
          error_message: "request blocked by prompt guard",
          api_key_id: clientApiKeyId,
          endpoint: kind,
        });
        return json(
          {
            error: {
              message: "request blocked by prompt guard",
              type: "prompt_guard_blocked",
              code: "prompt_guard_blocked",
            },
          },
          400,
        );
      }
    }

    let pool = model ? getProviders(model) : [];
    if (_prefixInfoMedia?.providerId) {
      const hinted = pool.filter((p) => p.id === _prefixInfoMedia.providerId);
      if (hinted.length > 0) pool = hinted;
    }
    if (rule) {
      pool = pool.filter((p) => providerAllowed(rule, p.id) && !providerBlocked(rule, p.id));
    }

    if (pool.length === 0) {
      if (rule && model) {
        const unfiltered = getProviders(model);
        if (unfiltered.length > 0) {
          return json({ error: { message: "no allowed provider for api key" } }, 403);
        }
      }
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

    const selected =
      (rule?.pinned_provider_id ? pool.find((p) => p.id === rule.pinned_provider_id) : undefined) ??
      selectProvider(pool, model) ??
      pool[0];
    const candidates: Provider[] = [selected];
    const alt = pool.find((p) => p.id !== selected.id);
    if (alt) candidates.push(alt);

    const reqStartId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    let lastStatus = 502;

    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const provider = candidates[attempt]!;
      beginConnection(provider.id);
      const entry = getRegistryEntry(provider.id);
      const url = buildMediaUrl(provider.base_url, entry?.urlSuffix, kind);
      const headers = buildAuthHeaders(provider, entry, contentType);

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
          signal: AbortSignal.any([AbortSignal.timeout(MEDIA_TIMEOUT_MS), request.signal]),
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
          error_message: err instanceof Error ? err.message : String(err),
          endpoint: kind,
          via_proxy: usedProxyId != null ? 1 : 0,
          proxy_id: usedProxyId,
          api_key_id: clientApiKeyId,
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

      if (rule) {
        recordRequestUsage(rule, {
          model: model || kind,
          providerId: provider.id,
          status: resp.status,
          promptTokens: 0,
          completionTokens: 0,
          ip: clientIp,
          userAgent: request.headers.get("user-agent"),
        });
      }

      if (resp.ok) {
        return new Response(resp.body, {
          status: resp.status,
          headers: {
            "Content-Type": safeMediaContentType(resp.headers.get("content-type"), kind),
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      lastStatus = resp.status;
    }

    return json({ error: { message: `media request failed (HTTP ${lastStatus})` } }, lastStatus);
  } finally {
    if (rule && concurrentScope) {
      releaseConcurrency(rule, concurrentScope);
    }
  }
}
