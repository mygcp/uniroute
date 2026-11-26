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
	modelBlocked,
	providerAllowed,
	providerBlocked,
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
import { getPoolForApiKey, getPoolForProvider } from "./outbound-proxy";
import { estimateCost } from "./pricing";
import { evaluateCanonicalPromptGuard } from "./prompt-guard";
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
	checkScope,
	clientIpFromRequest,
	isKeyExpired,
	releaseConcurrency,
	releaseInFlightBudget,
	reserveInFlightBudget,
} from "./key-enforce";
import {
	autoBlockKey,
	maybeRotateForInterval,
	recordRequestUsage,
} from "./key-ops";
import {
	composeStreamTransformer,
	toProvider,
	translateResponse,
	type ClientFormat,
	type CanonicalRequest,
} from "./translate";
import { extractMessageTextAll } from "./translate/canonical";
import { enqueueWebhook } from "./webhook";

const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGES = 512;
const MAX_TOOLS = 128;
const MAX_TOKENS_CEILING = 1_000_000;

function json(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

type AuthorizeResult =
	| { ok: true; rule: ClientKey | null }
	| { ok: false; status: number; error: string };

function estimatePromptTokens(canonical: CanonicalRequest): number {
	let chars = 0;
	for (const msg of canonical.messages) {
		const text = extractMessageTextAll(msg);
		if (text) chars += text.length;
		if (msg.tool_calls && msg.tool_calls.length > 0) {
			for (const tc of msg.tool_calls) {
				chars += tc.function.name.length + tc.function.arguments.length;
			}
		}
	}
	if (canonical.tools && canonical.tools.length > 0) {
		chars += JSON.stringify(canonical.tools).length;
	}
	return Math.ceil(chars / 4);
}

function extractApiToken(request: Request): string | null {
	const header = request.headers.get("authorization") ?? "";
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (match) return match[1].trim();
	const xKey = request.headers.get("x-api-key")?.trim();
	return xKey || null;
}

function authorize(
	request: Request,
	canonical: CanonicalRequest,
	promptTokensEstimate: number,
): AuthorizeResult {
	if (isValid(getSessionToken(request))) {
		return { ok: true, rule: null };
	}
	const token = extractApiToken(request);

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

	const scopeCheck = checkScope(key, "chat");
	if (!scopeCheck.ok) return scopeCheck;

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

	const rateCheck = checkRate(key, promptTokensEstimate);
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
	endpoint?: string;
};

export async function handleProxy(
	request: Request,
	config: ProxyHandlerConfig,
): Promise<Response> {
	const contentLength = Number(request.headers.get("content-length") ?? 0);
	if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
		return json({ error: { message: "request payload too large" } }, 413);
	}

	let rawText: string;
	try {
		rawText = await request.text();
	} catch {
		return json({ error: { message: "invalid JSON body" } }, 400);
	}
	if (rawText.length > MAX_JSON_BODY_BYTES) {
		return json({ error: { message: "request payload too large" } }, 413);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(rawText);
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

	if (canonical.messages.length > MAX_MESSAGES) {
		return json({ error: { message: `messages exceed maximum of ${MAX_MESSAGES}` } }, 400);
	}
	if ((canonical.tools?.length ?? 0) > MAX_TOOLS) {
		return json({ error: { message: `tools exceed maximum of ${MAX_TOOLS}` } }, 400);
	}
	if (
		canonical.max_tokens !== undefined &&
		(!Number.isFinite(canonical.max_tokens) ||
			canonical.max_tokens < 1 ||
			canonical.max_tokens > MAX_TOKENS_CEILING)
	) {
		canonical.max_tokens = Math.min(MAX_TOKENS_CEILING, Math.max(1, Math.floor(canonical.max_tokens || 1)));
	}

	const promptTokensEstimate = estimatePromptTokens(canonical);
	const clientKey = authorize(request, canonical, promptTokensEstimate);
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

	const _displayModel = canonical.model;
	const _prefixInfo = resolveDisplayToBare(canonical.model);
	if (_prefixInfo.providerId) {
		canonical.model = _prefixInfo.bare;
	}

	const initialCombo = resolveCombo(_displayModel) ?? resolveCombo(canonical.model);

	let concurrentScope: string | null = null;
	if (clientKey.rule) {
		const conc = acquireConcurrency(clientKey.rule);
		if (!conc.ok) {
			return json({ error: { message: "too many concurrent requests" } }, 429);
		}
		concurrentScope = conc.scope;
	}

	let reservedBudget = 0;
	let handedOffToStream = false;
	let resourcesReleased = false;
	const releaseResources = (): void => {
		if (resourcesReleased) return;
		resourcesReleased = true;
		if (clientKey.rule && concurrentScope) {
			releaseConcurrency(clientKey.rule, concurrentScope);
		}
		if (clientKey.rule && reservedBudget > 0) {
			releaseInFlightBudget(clientKey.rule.id, reservedBudget);
		}
	};

	try {
		if (clientKey.rule) {
			const blockedPre =
				modelBlocked(clientKey.rule, _displayModel) ||
				modelBlocked(clientKey.rule, canonical.model);
			const allowedPre =
				initialCombo !== null ||
				modelAllowed(clientKey.rule, _displayModel) ||
				modelAllowed(clientKey.rule, canonical.model);
			if (blockedPre || !allowedPre) {
				recordRequestLog({
					model: canonical.model,
					provider_id: "guard",
					status: "denied",
					rule_applied: "client-key allowlist",
					error_message: "model not allowed by api key",
					api_key_id: clientKey.rule.id,
					endpoint: config.endpoint ?? "chat",
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
		}

		if (clientKey.rule?.model_override) {
			canonical.model = clientKey.rule.model_override;
		}

		const guardBare = checkAllowlist(canonical.model);
		const guardDisplay =
			_displayModel !== canonical.model
				? checkAllowlist(_displayModel)
				: { ok: true as const };
		const guard = !guardBare.ok
			? guardBare
			: !guardDisplay.ok
				? guardDisplay
				: { ok: true as const };
		if (!guard.ok) {
			recordRequestLog({
				model: _displayModel,
				provider_id: "guard",
				status: "denied",
				rule_applied: "allowlist",
				error_message: (guard as { reason: string }).reason,
				api_key_id: clientKey.rule?.id ?? null,
				endpoint: config.endpoint ?? "chat",
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
				api_key_id: clientKey.rule?.id ?? null,
				endpoint: config.endpoint ?? "chat",
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

		let effectiveModel = canonical.model;
		let ruleApplied: string | null = null;
		if (rule.action === "rewrite") {
			effectiveModel = rule.targetModel;
			canonical.model = rule.targetModel;
			ruleApplied = rule.ruleApplied;
			if (
				clientKey.rule &&
				!resolveCombo(effectiveModel) &&
				(!modelAllowed(clientKey.rule, effectiveModel) ||
					modelBlocked(clientKey.rule, effectiveModel))
			) {
				recordRequestLog({
					model: effectiveModel,
					provider_id: "guard",
					status: "denied",
					rule_applied: "client-key allowlist",
					error_message: "model not allowed by api key",
					api_key_id: clientKey.rule.id,
					endpoint: config.endpoint ?? "chat",
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
		}

		const promptGuard = evaluateCanonicalPromptGuard(canonical);
		if (promptGuard.matches.length > 0) {
			recordProxyLog({
				level: "warn",
				source: "prompt-guard",
				message: `${promptGuard.blocked ? "blocked" : "flagged"}: ${promptGuard.reason ?? "policy match"}`,
				client_ip: clientIpFromRequest(request),
				api_key_id: clientKey.rule?.id ?? null,
				endpoint: config.endpoint ?? "chat",
			});
		}
		if (promptGuard.blocked) {
			recordRequestLog({
				model: effectiveModel,
				provider_id: "guard",
				status: "denied",
				rule_applied: `prompt-guard:${promptGuard.reason ?? "matched"}`,
				error_message: "request blocked by prompt guard",
				api_key_id: clientKey.rule?.id ?? null,
				endpoint: config.endpoint ?? "chat",
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

		if (clientKey.rule?.budget) {
			const estOut = Math.min(canonical.max_tokens ?? 1024, 16_384);
			const estCost = estimateCost(effectiveModel, null, promptTokensEstimate, estOut);
			const perReq = clientKey.rule.budget.per_request;
			if (perReq != null && perReq > 0 && estCost > perReq) {
				return json({ error: { message: "per-request budget limit exceeded" } }, 429);
			}
			reservedBudget = reserveInFlightBudget(clientKey.rule.id, estCost);
			const recheck = checkBudgetQuota(clientKey.rule);
			if (!recheck.ok) {
				return json({ error: { message: recheck.reason ?? "budget exceeded" } }, 429);
			}
		}

		await compressCanonicalRequest(canonical);

		const fallbackId = rule.action === "fallback" ? rule.targetProviderId : null;
		const resolvedCombo = resolveCombo(effectiveModel) ?? initialCombo;
		if (resolvedCombo) {
			const comboResp = await runComboEngine({
				combo: resolvedCombo,
				canonical,
				rule: clientKey.rule,
				ruleApplied,
				request,
				clientFormat: config.clientFormat,
			});
			return comboResp;
		}

		let pool = getProviders(effectiveModel);
		if (_prefixInfo.providerId) {
			const hinted = pool.filter((p) => p.id === _prefixInfo.providerId);
			if (hinted.length > 0) pool = hinted;
		}
		if (pool.length === 0) {
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

		if (clientKey.rule) {
			const keyRule = clientKey.rule;
			pool = pool.filter(
				(p) => providerAllowed(keyRule, p.id) && !providerBlocked(keyRule, p.id),
			);
			if (pool.length === 0) {
				recordRequestLog({
					model: effectiveModel,
					provider_id: "guard",
					status: "denied",
					rule_applied: "client-key provider policy",
					error_message: "provider not allowed by api key",
					api_key_id: keyRule.id,
					endpoint: config.endpoint ?? "chat",
				});
				return json(
					{ error: { message: "provider not allowed by api key", type: "provider_forbidden" } },
					403,
				);
			}
		}

		const cfg = getStrategy(effectiveModel);
		const selected = selectProvider(pool, effectiveModel, cfg) ?? pool[0];
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

			const activeKeys =
				provider.auth_type === "none"
					? []
					: listApiKeys(provider.id)
							.filter((k) => k.is_active === 1)
							.sort((a, b) => b.is_routing - a.is_routing || a.id - b.id);
			const keyAttempts = activeKeys.length > 0 ? activeKeys : [null];
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

				let streamCallReturned = false;
				let usedProxy: ProxyUsedInfo | null = null;
				const onProxyUsed = (info: ProxyUsedInfo | null): void => {
					if (info != null) usedProxy = info;
				};
				const logClientIp = clientIpFromRequest(request);
				const logApiKeyId = clientKey.rule?.id ?? null;
				const reqStartId = `${Date.now().toString(36)}-${Math.random()
					.toString(36)
					.slice(2, 7)}`;

				const onComplete = (
					log: Partial<RequestLog> & Pick<RequestLog, "status">,
				) => {
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
						recordRequestUsage(clientKey.rule, {
							model: effectiveModel,
							providerId: provider.id,
							status: log.status === "success" ? 200 : 500,
							promptTokens: log.prompt_tokens ?? 0,
							completionTokens: log.completion_tokens ?? 0,
							ip: logClientIp,
							userAgent: request.headers.get("user-agent"),
						});
					}
					endConnection(provider.id);
					if (streamCallReturned) {
						releaseResources();
					}
				};

				const providerPoolId = getPoolForProvider(provider.id)?.id ?? undefined;
				const routingCred = activeKeys.find((k) => k.is_routing === 1) ?? activeKeys[0];
				const accountPoolId =
					cred?.proxy_pool_id ?? routingCred?.proxy_pool_id ?? getRoutingPoolId(provider.id);

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
						apiKeyPoolId,
						accountPoolId,
						providerPoolId,
						providerId: provider.id,
					});
					streamCallReturned = true;
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
					if (canonical.stream) {
						handedOffToStream = true;
					}
					break;
				}
				if (response.status === 401 || response.status === 429) continue;
				break;
			}

			if (providerOk) break;
		}

		return (
			response ?? json({ error: { message: "no provider available" } }, 502)
		);
	} finally {
		if (!handedOffToStream) {
			releaseResources();
		}
	}
}
