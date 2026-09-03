import { transformRequest } from "./adapter";
import { beginConnection, endConnection, selectProvider } from "./balancer";
import { modelAllowed, type ClientKey } from "./client-key";
import { listApiKeys, type ApiKeyRow } from "./credential";
import {
	comboProxyPoolId,
	extractUpstreamText,
	recordComboMetric,
	type Combo,
	type ComboStep,
} from "./combo";
import { executeJson, executeStreaming } from "./executor";
import { clientIpFromRequest } from "./key-enforce";
import { recordRequestUsage } from "./key-ops";
import { recordProxyLog, recordRequestLog, type RequestLog } from "./logger";
import { getPoolForApiKey, getPoolForProvider } from "./outbound-proxy";
import { estimateCost } from "./pricing";
import {
	getAnyProvider,
	getProviders,
	reload,
	type Provider,
} from "./registry";
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
	model: string,
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
			content: `[Output dari langkah sebelumnya]\n${carryText}`,
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
	if (step.providerId) {
		const pinned = pool.filter((p) => p.id === step.providerId);
		if (pinned.length > 0) return pinned;
		return pool;
	}
	return pool;
}

/** Resolusi api key akun: akun spesifik atau null (= auto/dynamic). */
function resolveAccountApiKey(
	step: ComboStep,
	providerId: string,
): ApiKeyRow | null {
	const keys = listApiKeys(providerId).filter((k) => k.is_active === 1);
	if (keys.length === 0) return null;
	// Dynamic (kosong) = semua akun aktif provider ini.
	const wanted =
		step.accountIds && step.accountIds.length > 0
			? keys.filter((k) => step.accountIds!.includes(k.id))
			: keys;
	if (wanted.length === 0) return null;
	// Rotasi sederhana merata antar akun terpilih.
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

	// Model yang tidak diizinkan oleh api key → dilewati (lanjut ke model/step lain).
	if (ctx.rule && !modelAllowed(ctx.rule, model)) {
		recordProxyLog({
			level: "info",
			source: "combo",
			message: `${label}: model ${model} skipped (not allowed by api key)`,
			metadata: { model },
		});
		return {
			kind: "fail",
			status: 0,
			error: `model ${model} not allowed by api key`,
		};
	}

	const pool = resolveStepPool(ctx, step, model);
	const provider = step.providerId
		? (pool.find((p) => p.id === step.providerId) ?? pool[0])
		: (selectProvider(pool, model) ?? pool[0]);

	if (!provider) {
		logFailure(ctx, model, `model ${model} not found`);
		recordComboMetric({
			comboId: ctx.combo.id,
			comboName: ctx.combo.name,
			strategy: ctx.combo.strategy,
			stepIndex: index,
			modelId: model,
			providerId: step.providerId ?? null,
			latencyMs: Date.now() - started,
			success: false,
			error: "model not found",
		});
		return { kind: "fail", status: 404, error: `model ${model} not found` };
	}

	const stepCanonical = buildStepCanonical(
		ctx,
		model,
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
			model,
			apiKey: apiKey?.api_key ?? null,
		});
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		logFailure(ctx, model, error);
		recordComboMetric({
			comboId: ctx.combo.id,
			comboName: ctx.combo.name,
			strategy: ctx.combo.strategy,
			stepIndex: index,
			modelId: model,
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
 * Jalankan satu step (bisa berisi beberapa model sebagai fallback pada provider
 * yang sama). Model dicoba berurutan; gagal → lanjut ke model berikutnya.
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
		// Upstream gagal — coba model fallback berikutnya pada provider yang sama.
	}
	return lastFail;
}

/**
 * Jalankan Combo untuk satu request.
 *
 * - `priority`: coba step demi step (dan model dalam step); yang berhasil → return.
 *   Untuk request streaming, fallback hanya terjadi sebelum stream mulai.
 * - `pipeline`: jalankan step berurutan; tiap step menerima output step
 *   sebelumnya (kecuali step terakhir yang boleh streaming bila diminta).
 *   Step perantara yang gagal → hentikan dengan error.
 */
export async function runComboEngine(
	params: ComboRunParams,
): Promise<Response> {
	const ctx: RunContext = params;
	reload();

	let carryText: string | null = null;
	let lastFail = { status: 502, error: "all combo steps failed" };

	for (let i = 0; i < ctx.combo.steps.length; i += 1) {
		const step = ctx.combo.steps[i];
		const isFinal = i === ctx.combo.steps.length - 1;
		const label = step.modelIds[0] ?? "";

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

		lastFail = {
			status: outcome.status || lastFail.status,
			error: outcome.error,
		};

		if (ctx.combo.strategy === "pipeline") {
			return json(
				{
					error: {
						message: `combo pipeline failed at step ${i + 1} (${label})`,
						detail: outcome.error,
					},
				},
				outcome.status || 502,
			);
		}
	}

	return json({ error: { message: lastFail.error } }, lastFail.status);
}
