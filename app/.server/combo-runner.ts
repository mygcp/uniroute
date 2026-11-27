import { transformRequest } from "./adapter";
import { beginConnection, endConnection, selectProvider } from "./balancer";
import { providerAllowed, providerBlocked, type ClientKey } from "./client-key";
import { listApiKeys, type ApiKeyRow } from "./credential";
import {
	comboProxyPoolId,
	extractUpstreamText,
	recordComboMetric,
	type Combo,
	type ComboStep,
} from "./combo";
import { executeJson, executeStreaming } from "./executor";
import { checkAllowlist } from "./guard";
import { checkModelProviders, clientIpFromRequest } from "./key-enforce";
import { recordRequestUsage } from "./key-ops";
import { recordProxyLog, recordRequestLog, type RequestLog } from "./logger";
import { getPoolForApiKey, getPoolForProvider } from "./outbound-proxy";
import { estimateCost } from "./pricing";
import {
	getAnyProvider,
	getProviders,
	type Provider,
} from "./registry";
import { evaluateRules } from "./rules";
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
	/** clientKey.rule, or null when unauthenticated. */
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
 * Build canonical request for a single step:
 * - priority: original messages (+ step prompt as system hint if present)
 * - pipeline: original messages + previous step output + step prompt
 */
function buildStepCanonical(
	ctx: RunContext,
	model: string,
	step: ComboStep,
	index: number,
	carryText: string | null,
	isFinal: boolean,
): CanonicalRequest {
	const messages = cloneMessages(ctx.canonical.messages);

	if (step.prompt) {
		// Insert step instructions after existing system messages.
		let insertAt = 0;
		while (insertAt < messages.length && messages[insertAt].role === "system")
			insertAt += 1;
		messages.splice(insertAt, 0, {
			role: "system",
			content: step.prompt,
		} satisfies CanonicalMessage);
	}

	if (ctx.combo.strategy === "pipeline" && index > 0 && carryText) {
		messages.push({
			role: "user",
			content: `[Output from previous step]\n${carryText}`,
		} satisfies CanonicalMessage);
	}

	const stream =
		ctx.combo.strategy === "pipeline"
			? isFinal && ctx.canonical.stream
			: ctx.canonical.stream;

	return { ...ctx.canonical, model, stream, messages };
}

function resolveStepPool(
	ctx: RunContext,
	step: ComboStep,
	model: string,
): Provider[] {
	let pool = getProviders(model);
	if (pool.length === 0) pool = getAnyProvider(model);
	if (ctx.rule) {
		pool = pool.filter(
			(p) => providerAllowed(ctx.rule!, p.id) && !providerBlocked(ctx.rule!, p.id),
		);
	}
	if (step.providerId) {
		const pinned = pool.filter((p) => p.id === step.providerId);
		if (pinned.length > 0) return pinned;
		return pool;
	}
	return pool;
}

/** Resolve account API key: specific account or null (auto/dynamic). */
function resolveAccountApiKey(
	step: ComboStep,
	providerId: string,
): ApiKeyRow | null {
	const keys = listApiKeys(providerId).filter((k) => k.is_active === 1);
	if (keys.length === 0) return null;
	// Dynamic (empty) = all active accounts for this provider.
	const wanted =
		step.accountIds && step.accountIds.length > 0
			? keys.filter((k) => step.accountIds!.includes(k.id))
			: keys;
	if (wanted.length === 0) return null;
	// Simple round-robin rotation across selected accounts.
	const idx = Math.floor(Math.random() * wanted.length);
	return wanted[idx];
}

function logFailure(ctx: RunContext, model: string, error: string): void {
	recordRequestLog({
		model,
		provider_id: "combo",
		strategy_used: `combo:${ctx.combo.strategy}`,
		rule_applied: ctx.ruleApplied,
		status: "error",
		error_message: error,
		api_key_id: ctx.rule?.id ?? null,
	} as never);
}

async function executeOneModel(
	ctx: RunContext,
	step: ComboStep,
	model: string,
	index: number,
	carryText: string | null,
	isFinal: boolean,
): Promise<StepOutcome> {
	const started = Date.now();
	const label = `${ctx.combo.name}[${index + 1}]`;

	const allowCheck = checkAllowlist(model);
	if (!allowCheck.ok) {
		return { kind: "fail", status: 403, error: allowCheck.reason };
	}

	let effectiveModel = model;
	const ruleEval = evaluateRules(effectiveModel);
	if (ruleEval.action === "deny") {
		return { kind: "fail", status: 403, error: "model denied by routing rule" };
	}
	if (ruleEval.action === "rewrite") {
		effectiveModel = ruleEval.targetModel;
	}

	if (ctx.rule) {
		const preCheck = checkModelProviders(ctx.rule, effectiveModel, null);
		if (!preCheck.ok) {
			recordProxyLog({
				level: "info",
				source: "combo",
				message: `${label}: model ${effectiveModel} skipped (${preCheck.error})`,
				metadata: { model: effectiveModel },
			});
			return {
				kind: "fail",
				status: 0,
				error: preCheck.error,
			};
		}
	}

	const pool = resolveStepPool(ctx, step, effectiveModel);
	const provider = step.providerId
		? (pool.find((p) => p.id === step.providerId) ?? pool[0])
		: (selectProvider(pool, effectiveModel) ?? pool[0]);

	if (!provider) {
		logFailure(ctx, effectiveModel, `model ${effectiveModel} not found`);
		recordComboMetric({
			comboId: ctx.combo.id,
			comboName: ctx.combo.name,
			strategy: ctx.combo.strategy,
			stepIndex: index,
			modelId: effectiveModel,
			providerId: step.providerId ?? null,
			latencyMs: Date.now() - started,
			success: false,
			error: "model not found",
		});
		return { kind: "fail", status: 404, error: `model ${effectiveModel} not found` };
	}

	if (ctx.rule) {
		const provCheck = checkModelProviders(ctx.rule, effectiveModel, provider.id);
		if (!provCheck.ok) {
			return { kind: "fail", status: 0, error: provCheck.error };
		}
	}

	const stepCanonical = buildStepCanonical(
		ctx,
		effectiveModel,
		step,
		index,
		carryText,
		isFinal,
	);
	const entry = getRegistryEntry(provider.id);
	const providerFormat =
		entry?.format === "claude" ? "anthropic" : (entry?.format ?? "openai");

	let providerBody: Record<string, unknown>;
	let transformed: { url: string; headers: Headers; body: string };
	const apiKey = resolveAccountApiKey(step, provider.id);
	try {
		providerBody = toProvider(providerFormat, stepCanonical);
		transformed = transformRequest(providerBody, provider, {
			model: effectiveModel,
			apiKey: apiKey?.api_key ?? null,
		});
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		logFailure(ctx, effectiveModel, error);
		recordComboMetric({
			comboId: ctx.combo.id,
			comboName: ctx.combo.name,
			strategy: ctx.combo.strategy,
			stepIndex: index,
			modelId: effectiveModel,
			providerId: provider.id,
			latencyMs: Date.now() - started,
			success: false,
			error,
		});
		return { kind: "fail", status: 500, error };
	}

	beginConnection(provider.id);
	const onComplete = (
		log: Partial<RequestLog> & Pick<RequestLog, "status">,
	) => {
		const ok = log.status === "success";
		recordRequestLog({
			model,
			provider_id: provider.id,
			strategy_used: `combo:${ctx.combo.strategy}`,
			rule_applied: ctx.ruleApplied,
			...log,
			api_key_id: ctx.rule?.id ?? null,
		} as never);
		if (ctx.rule) {
			recordRequestUsage(ctx.rule.id, {
				model,
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
			modelId: model,
			providerId: provider.id,
			latencyMs: log.duration_ms ?? Date.now() - started,
			cost: estimateCost(
				model,
				provider.id,
				log.prompt_tokens ?? 0,
				log.completion_tokens ?? 0,
			),
			success: ok,
			tokensUsed: (log.prompt_tokens ?? 0) + (log.completion_tokens ?? 0),
			error: ok ? null : (log.error_message ?? "step failed"),
		});
		endConnection(provider.id);
	};

	if (stepCanonical.stream) {
		const comboPoolId = comboProxyPoolId(ctx.combo) ?? undefined;
		const response = await executeStreaming({
			url: transformed.url,
			headers: transformed.headers,
			body: transformed.body,
			signal: ctx.request.signal,
			streamTransformer: composeStreamTransformer(
				providerFormat,
				ctx.clientFormat,
			),
			onComplete,
			apiKeyPoolId: ctx.rule
				? (getPoolForApiKey(ctx.rule.id)?.id ?? undefined)
				: undefined,
			comboPoolId,
			providerPoolId: getPoolForProvider(provider.id)?.id ?? undefined,
			providerId: provider.id,
		});
		if (response.status < 400) {
			return { kind: "ok", response, text: "" };
		}
		return {
			kind: "fail",
			status: response.status,
			error: `stream failed (HTTP ${response.status})`,
		};
	}

	const result = await executeJson({
		url: transformed.url,
		headers: transformed.headers,
		body: transformed.body,
		signal: ctx.request.signal,
		onComplete,
		apiKeyPoolId: ctx.rule
			? (getPoolForApiKey(ctx.rule.id)?.id ?? undefined)
			: undefined,
		comboPoolId: comboProxyPoolId(ctx.combo) ?? undefined,
		providerPoolId: getPoolForProvider(provider.id)?.id ?? undefined,
		providerId: provider.id,
	});
	if (result.ok) {
		const text = extractUpstreamText(result.json);
		return {
			kind: "ok",
			response: json(
				translateResponse(providerFormat, ctx.clientFormat, result.json),
				result.status,
			),
			text,
		};
	}
	return { kind: "fail", status: result.status, error: result.error };
}

/**
 * Execute one step (trying its fallback models sequentially on the same provider).
 */
async function executeStep(
	ctx: RunContext,
	step: ComboStep,
	index: number,
	carryText: string | null,
	isFinal: boolean,
): Promise<StepOutcome> {
	const models = step.modelIds.length > 0 ? step.modelIds : [""];
	let lastFail: StepOutcome = {
		kind: "fail",
		status: 502,
		error: "combo step failed",
	};

	for (const model of models) {
		const outcome = await executeOneModel(
			ctx,
			step,
			model,
			index,
			carryText,
			isFinal,
		);
		if (outcome.kind === "ok") return outcome;
		lastFail = outcome;
		if (outcome.status === 0) {
		}
		// Upstream failed; try next fallback model on the same provider.
	}
	return lastFail;
}

/**
 * Run Combo for a single request (`priority` fallback chain or sequential `pipeline`).
 */
export async function runComboEngine(
	params: ComboRunParams,
): Promise<Response> {
	const ctx: RunContext = params;

	let carryText: string | null = null;
	let lastFail = { status: 502, error: "all combo steps failed" };

	for (let i = 0; i < ctx.combo.steps.length; i += 1) {
		const step = ctx.combo.steps[i];
		const isFinal = i === ctx.combo.steps.length - 1;
		const label = step.modelIds[0] ?? "";

		const outcome = await executeStep(ctx, step, i, carryText, isFinal);

		if (outcome.kind === "ok") {
			if (ctx.combo.strategy === "pipeline" && !isFinal) {
				carryText = outcome.text || "(step produced empty output)";
				continue;
			}
			return outcome.response;
		}

		lastFail = {
			status: outcome.status || lastFail.status,
			error: outcome.error,
		};

		if (ctx.combo.strategy === "pipeline") {
			return json(
				{
					error: {
						message: `combo pipeline failed at step ${i + 1} (${label})`,
					},
				},
				outcome.status || 502,
			);
		}
	}

	return json({ error: { message: "all combo steps failed" } }, lastFail.status);
}
