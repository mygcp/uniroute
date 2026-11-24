import { getSessionToken, isValid } from "./auth";
import { transformRequest } from "./adapter";
import {
	beginConnection,
	endConnection,
	getStrategy,
	markUsed,
	selectProvider,
} from "./balancer";
import {
	isRequireApiKey,
	modelAllowed,
	resolveClientKey,
	type ClientKey,
} from "./client-key";
import { getRoutingPoolId, listApiKeys } from "./credential";
import { compressCanonicalRequest } from "./compressor";
import { executeJson, executeStreaming, type ProxyUsedInfo } from "./executor";
import { checkAllowlist } from "./guard";
import { resolveCombo } from "./combo";
import { runComboEngine } from "./combo-runner";
import { recordProxyLog, recordRequestLog, type RequestLog } from "./logger";
import { broadcast } from "./log-stream";
import {
  getPoolForApiKey,
  getPoolForProvider,
} from "./outbound-proxy";
import { getProviders, type Provider } from "./registry";
import { evaluateRules } from "./rules";
import { getRegistryEntry } from "~/registry";
import { resolveDisplayToBare, unavailableReason } from "./provider-prefix";
import {
	acquireConcurrency,
	checkAccessHours,
	checkBudgetQuota,
	checkGroups,
	checkIp,
	checkRate,
	clientIpFromRequest,
	isKeyExpired,
	releaseConcurrency,
} from "./key-enforce";
import {
	autoBlockKey,
	maybeRotateForInterval,
	recordRequestUsage,
} from "./key-ops";
import {
	composeStreamTransformer,
	messageText,
	toProvider,
	translateResponse,
	type ClientFormat,
	type CanonicalRequest,
} from "./translate";
import type { StreamTransformer } from "./translate/canonical";
import { enqueueWebhook } from "./webhook";

function json(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

type AuthorizeResult =
	| { ok: true; rule: ClientKey | null }
	| { ok: false; status: number; error: string };

/** Estimasi prompt tokens murah: total karakter / 4 (untuk rate limit TPM). */
function estimatePromptTokens(canonical: CanonicalRequest): number {
	let chars = 0;
	for (const msg of canonical.messages) {
		const text = messageText(msg);
		if (text !== null) chars += text.length;
	}
	return Math.ceil(chars / 4);
}

function authorize(
	request: Request,
	canonical: CanonicalRequest,
): AuthorizeResult {
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
	const key = resolved.key;

	maybeRotateForInterval(key);

	if (isKeyExpired(key)) {
		return { ok: false, status: 403, error: "api key expired" };
	}

	const ipCheck = checkIp(key, clientIpFromRequest(request));
	if (!ipCheck.ok) return ipCheck;

	const hoursCheck = checkAccessHours(key);
	if (!hoursCheck.ok) return hoursCheck;

	const budgetCheck = checkBudgetQuota(key);
	if (!budgetCheck.ok) {
		if (key.auto_block === 1 && !key.blocked_at) {
			autoBlockKey(key.id, budgetCheck.reason ?? "budget exceeded");
		}
		return {
			ok: false,
			status: 429,
			error: budgetCheck.reason ?? "budget exceeded",
		};
	}

	const groupCheck = checkGroups(key);
	if (!groupCheck.ok) return groupCheck;

	const rateCheck = checkRate(key, estimatePromptTokens(canonical));
	if (!rateCheck.allowed) {
		if (key.webhook_url) {
			enqueueWebhook({
				keyId: key.id,
				event: "rate_limit",
				url: key.webhook_url,
				payload: {
					event: "rate_limit",
					key_id: key.id,
					key_prefix: key.key_prefix,
					limit: rateCheck.limit ?? "rpm",
					at: Date.now(),
				},
			});
		}
		return { ok: false, status: 429, error: "rate limit exceeded" };
	}

	return { ok: true, rule: key };
}

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

export type ProxyHandlerConfig = {
	clientFormat: ClientFormat;
	parse: (body: Record<string, unknown>) => CanonicalRequest;
	/** Label endpoint untuk request_logs (mis. "chat-completions"). */
	endpoint?: string;
};

export async function handleProxy(
	request: Request,
	config: ProxyHandlerConfig,
): Promise<Response> {
	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return json({ error: { message: "invalid JSON body" } }, 400);
	}

	const rawBody = (payload ?? {}) as Record<string, unknown>;
	let canonical: CanonicalRequest;
	try {
		canonical = config.parse(rawBody);
	} catch {
		return json({ error: { message: "model is required" } }, 400);
	}

	const clientKey = authorize(request, canonical);
	if (!clientKey.ok) {
		recordProxyLog({
			level: "warn",
			source: "auth",
			message: `request denied: ${clientKey.error}`,
			client_ip: clientIpFromRequest(request),
			endpoint: config.endpoint ?? "chat",
		});
		return json({ error: { message: clientKey.error } }, clientKey.status);
	}

	if (!canonical.model) {
		return json({ error: { message: "model is required" } }, 400);
	}

	// Prefix provider (virtual, hanya di aplikasi): mis. prefix "openai" +
	// model "gpt-4o" -> display "openai/gpt-4o". Custom display_name per-model
	// juga di-resolve di sini. Bare dikirim ke upstream, prefix/provider
	// dipakai untuk hint provider.
	const _displayModel = canonical.model;
	const _prefixInfo = resolveDisplayToBare(canonical.model);
	if (_prefixInfo.providerId) {
		canonical.model = _prefixInfo.bare;
	}

	let concurrentScope: string | null = null;
	if (clientKey.rule) {
		const conc = acquireConcurrency(clientKey.rule);
		if (!conc.ok) {
			return json({ error: { message: "too many concurrent requests" } }, 429);
		}
		concurrentScope = conc.scope;
	}

	try {
		if (
			clientKey.rule &&
			!modelAllowed(clientKey.rule, _displayModel) &&
			!modelAllowed(clientKey.rule, canonical.model) &&
			!resolveCombo(_displayModel) &&
			!resolveCombo(canonical.model)
		) {
			recordRequestLog({
				model: canonical.model,
				provider_id: "guard",
				status: "denied",
				rule_applied: "client-key allowlist",
				error_message: "model not allowed by api key",
			});
			return json(
				{
					error: {
						message: "model not allowed by api key",
						type: "model_forbidden",
					},
				},
				403,
			);
		}

		if (clientKey.rule?.model_override) {
			canonical.model = clientKey.rule.model_override;
		}

		const guardBare = checkAllowlist(canonical.model);
		const guardDisplay = _displayModel !== canonical.model ? checkAllowlist(_displayModel) : { ok: true as const };
		const guard = !guardBare.ok ? guardBare : !guardDisplay.ok ? guardDisplay : { ok: true as const };
		if (!guard.ok) {
			recordRequestLog({
				model: _displayModel,
				provider_id: "guard",
				status: "denied",
				rule_applied: "allowlist",
				error_message: (guard as { reason: string }).reason,
			});
			return json(
				{ error: { message: (guard as { reason: string }).reason, type: "model_denied" } },
				403,
			);
		}

		let rule = evaluateRules(canonical.model);
		if (rule.action === "none" && _displayModel !== canonical.model) {
			const r2 = evaluateRules(_displayModel);
			if (r2.action !== "none") rule = r2;
		}
		if (rule.action === "deny") {
			recordRequestLog({
				model: canonical.model,
				provider_id: "guard",
				status: "denied",
				rule_applied: rule.ruleApplied,
				error_message: "routing rule deny",
			});
			return json(
				{
					error: {
						message: "model denied by routing rule",
						rule: rule.ruleApplied,
					},
				},
				403,
			);
		}

		await compressCanonicalRequest(canonical);

		let effectiveModel = canonical.model;
		let ruleApplied: string | null = null;
		if (rule.action === "rewrite") {
			effectiveModel = rule.targetModel;
			canonical.model = rule.targetModel;
			ruleApplied = rule.ruleApplied;
		}
		const fallbackId =
			rule.action === "fallback" ? rule.targetProviderId : null;

		// Combo Engine (MVP: priority chain & pipeline sequential). Model reference
		// dari client: `combo:<nama>`. Step-level checks (allowlist key, dsb.)
		// ditangani di combo-runner.
		if (resolveCombo(effectiveModel)) {
			const combo = resolveCombo(effectiveModel)!;
			return runComboEngine({
				combo,
				canonical,
				rule: clientKey.rule,
				ruleApplied,
				request,
				clientFormat: config.clientFormat,
			});
		}

		let pool = getProviders(effectiveModel);
		// bila request memakai prefix provider, filter ke provider tersebut
		if (_prefixInfo.providerId) {
			const hinted = pool.filter((p) => p.id === _prefixInfo.providerId);
			if (hinted.length > 0) pool = hinted;
		}
		if (pool.length === 0) {
			// Bedakan "tidak dikenal" vs "dikenal tapi nonaktif" agar
			// client tahu harus ganti model atau aktifkan provider/model.
			const reason = unavailableReason(_displayModel);
			if (reason?.kind === "provider_disabled") {
				const message = `model '${_displayModel}' is unavailable: provider '${reason.providerName}' is disabled`;
				recordRequestLog({
					model: _displayModel,
					provider_id: reason.providerId,
					status: "error",
					error_message: message,
				});
				return json(
					{
						error: {
							message,
							type: "provider_disabled",
							model: _displayModel,
							provider: reason.providerId,
						},
					},
					404,
				);
			}
			if (reason?.kind === "model_disabled") {
				const message = `model '${_displayModel}' is disabled`;
				recordRequestLog({
					model: _displayModel,
					provider_id: reason.providerId,
					status: "error",
					error_message: message,
				});
				return json(
					{
						error: {
							message,
							type: "model_disabled",
							model: _displayModel,
							provider: reason.providerId,
						},
					},
					404,
				);
			}
			recordRequestLog({
				model: _displayModel,
				provider_id: "none",
				status: "error",
				error_message: "model not found",
			});
			return json(
				{
					error: {
						message: "model not found",
						type: "model_not_found",
						model: _displayModel,
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

		const apiKeyPoolId = clientKey.rule
			? (getPoolForApiKey(clientKey.rule.id)?.id ?? undefined)
			: undefined;

		let attempts = 0;
		let response: Response | null = null;
		const maxAttempts = Math.max(2, candidates.length * 2);

		for (const provider of candidates) {
			if (attempts >= maxAttempts) break;
			const entry = getRegistryEntry(provider.id);
			const providerFormat =
				entry?.format === "claude" ? "anthropic" : (entry?.format ?? "openai");

			let providerBody: Record<string, unknown>;
			try {
				providerBody = toProvider(providerFormat, canonical);
			} catch (err) {
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

			// Rotasi multi-account MANUAL: hanya berputar bila user sudah
			// menambah >1 key aktif di provider ini. Urutan routing-first.
			// Key berbeda dicoba bila 401/429 (key-specific); error lain
			// langsung lanjut ke provider berikutnya.
			const activeKeys =
				provider.auth_type === "none"
					? []
					: listApiKeys(provider.id)
							.filter((k) => k.is_active === 1)
							.sort((a, b) => b.is_routing - a.is_routing || a.id - b.id);
			const keyAttempts =
				activeKeys.length > 0 ? activeKeys : [null];
			let providerOk = false;

			for (const cred of keyAttempts) {
				if (attempts >= maxAttempts) break;
				attempts += 1;
				beginConnection(provider.id);

				let transformed;
				try {
					transformed = transformRequest(providerBody, provider, {
						model: effectiveModel,
						apiKey: cred?.api_key ?? undefined,
					});
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

			const onComplete = (
				log: Partial<RequestLog> & Pick<RequestLog, "status">,
			) => {
				// Metadata proxy sudah ditangkap saat egress (onProxyUsed) —
				// tidak perlu query ulang di sini.
				recordRequestLog({
					model: effectiveModel,
					provider_id: provider.id,
					strategy_used: cfg.strategy,
					rule_applied: ruleApplied,
					...log,
					api_key_id: clientKey.rule?.id ?? null,
					via_proxy: usedProxy != null ? 1 : 0,
					proxy_id: usedProxy?.id ?? null,
					proxy_name: usedProxy?.name ?? null,
					proxy_host: usedProxy?.host ?? null,
					proxy_port: usedProxy?.port ?? null,
					endpoint: config.endpoint ?? "chat",
					upstream_tls: transformed.url.startsWith("https://") ? 1 : 0,
				} as never);
				if (usedProxy != null) {
					recordProxyLog({
						level: "info",
						source: "egress",
						message: `upstream ${provider.id} via proxy #${usedProxy.id}`,
						proxy_id: usedProxy.id,
						provider_id: provider.id,
						client_ip: logClientIp,
						api_key_id: logApiKeyId,
						latency_ms: log.duration_ms ?? null,
						endpoint: config.endpoint ?? "chat",
					});
				}
				broadcast({ type: "request-end", reqId: reqStartId });
				if (clientKey.rule) {
					recordRequestUsage(clientKey.rule.id, {
						model: effectiveModel,
						providerId: provider.id,
						status: log.status === "success" ? 200 : 500,
						promptTokens: log.prompt_tokens ?? 0,
						completionTokens: log.completion_tokens ?? 0,
						ip: clientIpFromRequest(request),
						userAgent: request.headers.get("user-agent"),
					});
				}
				endConnection(provider.id);
			};

			const providerPoolId = getPoolForProvider(provider.id)?.id ?? undefined;
			// Pool milik kredensial (akun) yang dipakai untuk auth percobaan ini.
			const accountPoolId =
				cred?.proxy_pool_id ?? getRoutingPoolId(provider.id);

			// Metadata egress untuk request log (proxy terakhir yang dipakai).
			let usedProxy: ProxyUsedInfo | null = null;
			const onProxyUsed = (info: ProxyUsedInfo | null): void => {
				if (info != null) usedProxy = info;
			};
			const logClientIp = clientIpFromRequest(request);
			const logApiKeyId = clientKey.rule?.id ?? null;

			// Umumkan START ke monitor realtime (tidak disimpan ke DB) supaya
			// request paralel terlihat sebagai baris "running" sejak awal.
			const reqStartId = `${Date.now().toString(36)}-${Math.random()
				.toString(36)
				.slice(2, 7)}`;
			broadcast({
				type: "request-start",
				reqId: reqStartId,
				model: effectiveModel,
				provider_id: provider.id,
				endpoint: config.endpoint ?? "chat",
				client_ip: logClientIp,
				api_key_id: logApiKeyId,
				started_at: Date.now(),
			});

			if (canonical.stream) {
				response = await executeStreaming({
					url: transformed.url,
					headers: transformed.headers,
					body: transformed.body,
					signal: request.signal,
					streamTransformer: composeStreamTransformer(
						providerFormat,
						config.clientFormat,
					),
					onComplete,
					onProxyUsed,
					logClientIp,
					logApiKeyId,
					apiKeyPoolId,					accountPoolId,
					providerPoolId,
					providerId: provider.id,
				});
			} else {
				const result = await executeJson({
					url: transformed.url,
					headers: transformed.headers,
					body: transformed.body,
					signal: request.signal,
					onComplete,
					onProxyUsed,
					logClientIp,
					logApiKeyId,
					apiKeyPoolId,
					accountPoolId,
					providerPoolId,
					providerId: provider.id,
				});
				if (result.ok) {
					const translated = translateResponse(
						providerFormat,
						config.clientFormat,
						result.json,
					);
					response = json(translated, result.status);
				} else {
					response = json(
						{ error: { message: "provider request failed" } },
						result.status,
					);
				}
			}

			if (response.status < 400) {
				providerOk = true;
				break;
			}
			// 401/429 = key-specific → coba key berikutnya di provider SAMA
			// (hanya ada bila user sudah set multi-account manual).
			// Status lain → langsung ke provider berikutnya.
			if (response.status === 401 || response.status === 429) continue;
			break;
			}

			if (providerOk) break;
		}

		return (
			response ?? json({ error: { message: "no provider available" } }, 502)
		);
	} finally {
		if (clientKey.rule && concurrentScope) {
			releaseConcurrency(clientKey.rule, concurrentScope);
		}
	}
}
