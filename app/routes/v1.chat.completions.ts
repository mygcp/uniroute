import type { Route } from "./+types/v1.chat.completions";
import { getSessionToken, isValid } from "../.server/auth";
import { transformRequest } from "../.server/adapter";
import {
  beginConnection,
  endConnection,
  getStrategy,
  markUsed,
  selectProvider,
} from "../.server/balancer";
import {
  isRequireApiKey,
  modelAllowed,
  resolveClientKey,
  type ClientKey,
} from "../.server/client-key";
import { compress, isEnabled } from "../.server/compressor";
import { executeStreaming } from "../.server/executor";
import { checkAllowlist } from "../.server/guard";
import { recordProxyLog, recordRequestLog } from "../.server/logger";
import { getProviders, reload, type Provider } from "../.server/registry";
import { evaluateRules } from "../.server/rules";
import { resolveProxyCandidates } from "../.server/proxy-resolver";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type AuthorizeResult =
  | { ok: true; rule: ClientKey | null }
  | { ok: false; status: number; error: string };

function authorize(request: Request): AuthorizeResult {
  if (isValid(getSessionToken(request))) {
    return { ok: true, rule: null };
  }
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : null;

  if (!token) {
    if (isRequireApiKey()) {
      return { ok: false, status: 401, error: "api key required" };
    }
    return { ok: true, rule: null };
  }

  const resolved = resolveClientKey(token);
  if (!resolved.ok) {
    return { ok: false, status: resolved.status, error: resolved.message };
  }
  return { ok: true, rule: resolved.key };
}

type ChatRequestBody = {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  [key: string]: unknown;
};

function orderCandidates(
  pool: Provider[],
  selected: Provider,
  fallbackId: string | null | undefined,
  pinnedId: string | null | undefined,
): Provider[] {
  const list: Provider[] = [];
  const push = (p?: Provider) => {
    if (p && !list.includes(p)) list.push(p);
  };
  push(pool.find((p) => p.id === pinnedId));
  push(selected);
  if (fallbackId) push(pool.find((p) => p.id === fallbackId));
  for (const p of pool) push(p);
  return list;
}

export async function action({ request }: Route.ActionArgs) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: { message: "invalid JSON body" } }, 400);
  }

  const body = (payload ?? {}) as ChatRequestBody & Record<string, unknown>;
  const model =
    typeof body.model === "string" && body.model.trim() !== ""
      ? body.model.trim()
      : null;

  const clientKey = authorize(request);
  if (!clientKey.ok) {
    return json({ error: { message: clientKey.error } }, clientKey.status);
  }

  if (!model) {
    return json({ error: { message: "model is required" } }, 400);
  }

  if (clientKey.rule && !modelAllowed(clientKey.rule, model)) {
    recordRequestLog({
      model,
      provider_id: "guard",
      status: "denied",
      rule_applied: "client-key allowlist",
      error_message: "model not allowed by api key",
    });
    return json(
      { error: { message: "model not allowed by api key", type: "model_forbidden" } },
      403,
    );
  }

  if (clientKey.rule?.model_override) {
    body.model = clientKey.rule.model_override;
  }

  const guard = checkAllowlist(model);
  if (!guard.ok) {
    recordRequestLog({
      model,
      provider_id: "guard",
      status: "denied",
      rule_applied: "allowlist",
      error_message: guard.reason,
    });
    return json(
      { error: { message: guard.reason, type: "model_denied" } },
      403,
    );
  }

  const rule = evaluateRules(model);
  if (rule.action === "deny") {
    recordRequestLog({
      model,
      provider_id: "guard",
      status: "denied",
      rule_applied: rule.ruleApplied,
      error_message: "routing rule deny",
    });
    return json(
      { error: { message: "model denied by routing rule", rule: rule.ruleApplied } },
      403,
    );
  }

  const enabled = isEnabled();
  if (
    (enabled.rtk || enabled.caveman) &&
    Array.isArray(body.messages) &&
    body.messages.length > 0
  ) {
    const last = body.messages[body.messages.length - 1] as {
      content?: unknown;
    };
    if (typeof last.content === "string") {
      const { output, usedFallback, durationMs } = await compress(last.content);
      if (usedFallback) {
        recordProxyLog({
          level: "info",
          source: "compressor",
          message: "fallback to original prompt",
          metadata: { durationMs },
        });
      }
      last.content = output;
    }
  }

  let effectiveModel = model;
  let ruleApplied: string | null = null;
  if (rule.action === "rewrite") {
    effectiveModel = rule.targetModel;
    body.model = rule.targetModel;
    ruleApplied = rule.ruleApplied;
  }
  const fallbackId =
    rule.action === "fallback" ? rule.targetProviderId : null;

  const pool = getProviders(effectiveModel);
  if (pool.length === 0) {
    recordRequestLog({
      model: effectiveModel,
      provider_id: "none",
      status: "error",
      error_message: "model not found",
    });
    return json(
      {
        error: {
          message: "model not found",
          type: "model_not_found",
          model: effectiveModel,
        },
      },
      404,
    );
  }

  const cfg = getStrategy(effectiveModel);
  const selected = selectProvider(pool, effectiveModel) ?? pool[0];
  const candidates = orderCandidates(
    pool,
    selected,
    fallbackId,
    clientKey.rule?.pinned_provider_id,
  );
  markUsed(selected);
  reload();

  let attempts = 0;
  let response: Response | null = null;

  for (const provider of candidates) {
    if (attempts >= 2) break;
    attempts += 1;
    beginConnection(provider.id);

    let transformed;
    try {
      transformed = transformRequest(body, provider);
    } catch (err) {
      endConnection(provider.id);
      recordRequestLog({
        model: effectiveModel,
        provider_id: provider.id,
        strategy_used: cfg.strategy,
        rule_applied: ruleApplied,
        status: "error",
        error_message: err instanceof Error ? err.message : String(err),
      });
      response = json({ error: { message: "provider request failed" } }, 500);
      break;
    }

    response = await executeStreaming({
      url: transformed.url,
      headers: transformed.headers,
      body: transformed.body,
      signal: request.signal,
      proxies: resolveProxyCandidates(provider.id),
      onComplete: (log) => {
        recordRequestLog({
          model: effectiveModel,
          provider_id: provider.id,
          strategy_used: cfg.strategy,
          rule_applied: ruleApplied,
          ...log,
        });
        endConnection(provider.id);
      },
    });

    if (response.status < 400) break;
  }

  return response ?? json({ error: { message: "no provider available" } }, 502);
}