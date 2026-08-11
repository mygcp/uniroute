import { transformRequest } from "./adapter";
import { beginConnection, endConnection, selectProvider } from "./balancer";
import { modelAllowed, type ClientKey } from "./client-key";
import {
  extractUpstreamText,
  recordComboMetric,
  type Combo,
  type ComboStep,
} from "./combo";
import { executeJson, executeStreaming } from "./executor";
import { clientIpFromRequest } from "./key-enforce";
import { recordRequestUsage } from "./key-ops";
import { recordProxyLog, recordRequestLog, type RequestLog } from "./logger";
import { estimateCost } from "./pricing";
import { resolveProxyCandidates } from "./proxy-resolver";
import { getAnyProvider, getProviders, reload, type Provider } from "./registry";
import {
  composeStreamTransformer,
  toProvider,
  translateResponse,
  type CanonicalRequest,
  type ClientFormat,
} from "./translate";
import type { CanonicalMessage } from "./translate/canonical";
import { getRegistryEntry } from "~/registry";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export type ComboRunParams = {
  combo: Combo;
  canonical: CanonicalRequest;
  /** clientKey.rule — null bila request tanpa api key ter-otorisasi. */
  rule: ClientKey | null;
  ruleApplied: string | null;
  request: Request;
  clientFormat: ClientFormat;
};

type RunContext = {
  combo: Combo;
  canonical: CanonicalRequest;
  rule: ClientKey | null;
  ruleApplied: string | null;
  request: Request;
  clientFormat: ClientFormat;
};

type StepOk =
  | { kind: "ok"; response: Response; text: string }
  | { kind: "fail"; status: number; error: string };
type StepOutcome = StepOk;

function cloneMessages(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.map((m) => ({ ...m, content: m.content }));
}

/**
 * Bangun request canonical untuk satu step:
 * - priority: messages asli (+ prompt step sebagai system hint bila ada)
 * - pipeline: messages asli + output langkah sebelumnya + prompt step
 */
function buildStepCanonical(
  ctx: RunContext,
  step: ComboStep,
  index: number,
  carryText: string | null,
  isFinal: boolean,
): CanonicalRequest {
  const messages = cloneMessages(ctx.canonical.messages);

  if (step.prompt) {
    // Sisipkan instruksi step setelah system messages asli (provider umumnya
    // menginginkan system di awal).
    let insertAt = 0;
    while (insertAt < messages.length && messages[insertAt].role === "system") insertAt += 1;
    messages.splice(insertAt, 0, { role: "system", content: step.prompt } satisfies CanonicalMessage);
  }

  if (ctx.combo.strategy === "pipeline" && index > 0 && carryText) {
    messages.push({
      role: "user",
      content: `[Output dari langkah sebelumnya]\n${carryText}`,
    } satisfies CanonicalMessage);
  }

  const stream =
    ctx.combo.strategy === "pipeline" ? isFinal && ctx.canonical.stream : ctx.canonical.stream;

  return { ...ctx.canonical, model: step.modelId, stream, messages };
}

function resolveStepPool(ctx: RunContext, step: ComboStep): Provider[] {
  let pool = getProviders(step.modelId);
  if (pool.length === 0) pool = getAnyProvider(step.modelId);
  if (step.providerId) {
    const pinned = pool.filter((p) => p.id === step.providerId);
    if (pinned.length > 0) return pinned;
    return pool;
  }
  return pool;
}

function logFailure(ctx: RunContext, step: ComboStep, error: string): void {
  recordRequestLog({
    model: step.modelId,
    provider_id: "combo",
    strategy_used: `combo:${ctx.combo.strategy}`,
    rule_applied: ctx.ruleApplied,
    status: "error",
    error_message: error,
    api_key_id: ctx.rule?.id ?? null,
  } as never);
}

async function executeStep(
  ctx: RunContext,
  step: ComboStep,
  index: number,
  carryText: string | null,
  isFinal: boolean,
): Promise<StepOutcome> {
  const started = Date.now();
  const label = `${ctx.combo.name}[${index + 1}]`;

  // Step yang modelnya tidak diizinkan oleh api key → dilewati (bukan blokir
  // request, agar chain tetap bisa lanjut ke step yang diizinkan).
  if (ctx.rule && !modelAllowed(ctx.rule, step.modelId)) {
    recordProxyLog({
      level: "info",
      source: "combo",
      message: `${label}: step skipped (model not allowed by api key)`,
      metadata: { model: step.modelId },
    });
    return { kind: "fail", status: 0, error: `model ${step.modelId} not allowed by api key` };
  }

  const pool = resolveStepPool(ctx, step);
  const provider =
    step.providerId
      ? pool.find((p) => p.id === step.providerId) ?? pool[0]
      : selectProvider(pool, step.modelId) ?? pool[0];

  if (!provider) {
    logFailure(ctx, step, `model ${step.modelId} not found`);
    recordComboMetric({
      comboId: ctx.combo.id,
      comboName: ctx.combo.name,
      strategy: ctx.combo.strategy,
      stepIndex: index,
      modelId: step.modelId,
      providerId: step.providerId ?? null,
      latencyMs: Date.now() - started,
      success: false,
      error: "model not found",
    });
    return { kind: "fail", status: 404, error: `model ${step.modelId} not found` };
  }

  const stepCanonical = buildStepCanonical(ctx, step, index, carryText, isFinal);
  const entry = getRegistryEntry(provider.id);
  const providerFormat = entry?.format === "claude" ? "anthropic" : entry?.format ?? "openai";

  let providerBody: Record<string, unknown>;
  let transformed: { url: string; headers: Headers; body: string };
  try {
    providerBody = toProvider(providerFormat, stepCanonical);
    transformed = transformRequest(providerBody, provider, { model: step.modelId });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logFailure(ctx, step, error);
    recordComboMetric({
      comboId: ctx.combo.id,
      comboName: ctx.combo.name,
      strategy: ctx.combo.strategy,
      stepIndex: index,
      modelId: step.modelId,
      providerId: provider.id,
      latencyMs: Date.now() - started,
      success: false,
      error,
    });
    return { kind: "fail", status: 500, error };
  }

  beginConnection(provider.id);
  const proxies = resolveProxyCandidates(provider.id);
  const onComplete = (log: Partial<RequestLog> & Pick<RequestLog, "status">) => {
    const ok = log.status === "success";
    recordRequestLog({
      model: step.modelId,
      provider_id: provider.id,
      strategy_used: `combo:${ctx.combo.strategy}`,
      rule_applied: ctx.ruleApplied,
      ...log,
      api_key_id: ctx.rule?.id ?? null,
    } as never);
    if (ctx.rule) {
      recordRequestUsage(ctx.rule.id, {
        model: step.modelId,
        providerId: provider.id,
        status: ok ? 200 : 500,
        promptTokens: log.prompt_tokens ?? 0,
        completionTokens: log.completion_tokens ?? 0,
        ip: clientIpFromRequest(ctx.request),
        userAgent: ctx.request.headers.get("user-agent"),
      });
    }
    recordComboMetric({
      comboId: ctx.combo.id,
      comboName: ctx.combo.name,
      strategy: ctx.combo.strategy,
      stepIndex: index,
      modelId: step.modelId,
      providerId: provider.id,
      latencyMs: log.duration_ms ?? Date.now() - started,
      cost: estimateCost(step.modelId, provider.id, log.prompt_tokens ?? 0, log.completion_tokens ?? 0),
      success: ok,
      tokensUsed: (log.prompt_tokens ?? 0) + (log.completion_tokens ?? 0),
      error: ok ? null : (log.error_message ?? "step failed"),
    });
    endConnection(provider.id);
  };

  if (stepCanonical.stream) {
    const response = await executeStreaming({
      url: transformed.url,
      headers: transformed.headers,
      body: transformed.body,
      signal: ctx.request.signal,
      proxies,
      streamTransformer: composeStreamTransformer(providerFormat, ctx.clientFormat),
      onComplete,
    });
    if (response.status < 400) {
      return { kind: "ok", response, text: "" };
    }
    return { kind: "fail", status: response.status, error: `stream failed (HTTP ${response.status})` };
  }

  const result = await executeJson({
    url: transformed.url,
    headers: transformed.headers,
    body: transformed.body,
    signal: ctx.request.signal,
    proxies,
    onComplete,
  });
  if (result.ok) {
    const text = extractUpstreamText(result.json);
    return { kind: "ok", response: json(translateResponse(providerFormat, ctx.clientFormat, result.json), result.status), text };
  }
  return { kind: "fail", status: result.status, error: result.error };
}

/**
 * Jalankan Combo untuk satu request.
 *
 * - `priority`: coba step demi step; step pertama yang berhasil → return.
 *   Untuk request streaming, fallback hanya terjadi sebelum stream mulai.
 * - `pipeline`: jalankan step berurutan; tiap step menerima output step
 *   sebelumnya (kecuali step terakhir yang boleh streaming bila diminta).
 *   Step perantara yang gagal → hentikan dengan error.
 */
export async function runComboEngine(params: ComboRunParams): Promise<Response> {
  const ctx: RunContext = params;
  reload();

  let carryText: string | null = null;
  let lastFail = { status: 502, error: "all combo steps failed" };

  for (let i = 0; i < ctx.combo.steps.length; i += 1) {
    const step = ctx.combo.steps[i];
    const isFinal = i === ctx.combo.steps.length - 1;
    const outcome = await executeStep(ctx, step, i, carryText, isFinal);

    if (outcome.kind === "ok") {
      if (ctx.combo.strategy === "pipeline" && !isFinal) {
        // Chain output ke step berikutnya (step perantara non-stream dijamin
        // punya text; stream hanya diizinkan di step final).
        carryText = outcome.text || "(step menghasilkan output kosong)";
        continue;
      }
      return outcome.response;
    }

    lastFail = { status: outcome.status || lastFail.status, error: outcome.error };

    if (ctx.combo.strategy === "pipeline") {
      return json(
        {
          error: {
            message: `combo pipeline failed at step ${i + 1} (${step.modelId})`,
            detail: outcome.error,
          },
        },
        outcome.status || 502,
      );
    }
  }

  return json({ error: { message: lastFail.error } }, lastFail.status);
}