import { createStreamTransformer } from "./adapter";
import { fetchUpstream } from "./proxy-resolver";
import type { RequestLog } from "./logger";
import type { StreamTransformer } from "./translate/canonical";

export type ExecutorOptions = {
	url: string;
	headers: Headers;
	body: string;
	signal?: AbortSignal;
	apiKeyPoolId?: number;
	accountPoolId?: number;
	comboPoolId?: number;
	providerPoolId?: number;
	providerId?: string;
	onProxyUsed?: (info: ProxyUsedInfo | null) => void;
	logClientIp?: string | null;
	logApiKeyId?: number | null;
	streamTransformer?: StreamTransformer;
	onComplete: (log: Partial<RequestLog> & Pick<RequestLog, "status">) => void;
};

export type ProxyUsedInfo = {
	id: number;
	name: string;
	host: string;
	port: number;
};

type AttemptResult =
	| { ok: true; response: Response }
	| { ok: false; status: number; detailText: string; retryable: boolean };

const EXECUTE_TIMEOUT_MS = 120_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const ENCODER = new TextEncoder();
const EMPTY_BYTES = new Uint8Array(0);
const KEEP_ALIVE_BYTES = ENCODER.encode(": keep-alive\n\n");
export const UPSTREAM_DISCONNECT_CODE = "upstream_disconnect";
const DISCONNECT_BYTES = ENCODER.encode(
	`data: ${JSON.stringify({ error: { code: UPSTREAM_DISCONNECT_CODE, message: "upstream closed mid-stream" } })}\n\n`,
);
const SANITIZED_STREAM_ERROR_BODY = JSON.stringify({
	error: { message: "provider request failed" },
});
const DELTA_CONTENT_RE = /"delta":\{"content":"((?:[^"\\]|\\.)*)"/g;

async function attempt(options: ExecutorOptions): Promise<AttemptResult> {
	const {
		url,
		headers,
		body,
		signal,
		apiKeyPoolId,
		accountPoolId,
		providerPoolId,
		comboPoolId,
		providerId,
		logClientIp,
		logApiKeyId,
	} = options;
	const controller = new AbortController();
	const abortFromCaller = (): void => controller.abort();
	signal?.addEventListener("abort", abortFromCaller);

	try {
		const upstream = await fetchUpstream(url, {
			method: "POST",
			headers,
			body,
			signal: AbortSignal.any([
				AbortSignal.timeout(EXECUTE_TIMEOUT_MS),
				controller.signal,
			]),
			apiKeyPoolId,
			accountPoolId,
			providerPoolId,
			comboPoolId,
			providerId,
			onProxyUsed: options.onProxyUsed
				? (resolved) =>
						options.onProxyUsed?.({
							id: resolved.proxy.id,
							name: resolved.proxy.name,
							host: resolved.proxy.host,
							port: resolved.proxy.port,
						})
				: undefined,
			logClientIp,
			logApiKeyId,
		});

		if (!upstream.ok) {
			const detailText = await upstream.text();
			return {
				ok: false,
				status: upstream.status,
				detailText,
				retryable: RETRYABLE_STATUS.has(upstream.status),
			};
		}
		if (!upstream.body) {
			return {
				ok: false,
				status: 502,
				detailText: JSON.stringify({
					error: { message: "upstream returned empty body" },
				}),
				retryable: false,
			};
		}

		return { ok: true, response: upstream };
	} catch (err) {
		controller.abort();
		const message = err instanceof Error ? err.message : String(err);
		const isTimeout =
			err instanceof Error &&
			(err.name === "TimeoutError" || message.includes("aborted due to timeout"));
		return {
			ok: false,
			status: 502,
			detailText: JSON.stringify({ error: { message } }),
			retryable: !isTimeout,
		};
	} finally {
		signal?.removeEventListener("abort", abortFromCaller);
	}
}

async function runWithRetry(options: ExecutorOptions): Promise<AttemptResult> {
	let result = await attempt(options);
	if (!result.ok && result.retryable) {
		result = await attempt(options);
	}
	return result;
}

function countDeltaContent(text: string): number {
	DELTA_CONTENT_RE.lastIndex = 0;
	let tokens = 0;
	let match: RegExpExecArray | null;
	while ((match = DELTA_CONTENT_RE.exec(text)) !== null) {
		tokens += Math.max(1, Math.ceil(match[1].length / 4));
	}
	return tokens;
}

function extractUsage(json: unknown): {
	promptTokens: number | null;
	completionTokens: number | null;
	cachedTokens: number | null;
} {
	if (!json || typeof json !== "object")
		return { promptTokens: null, completionTokens: null, cachedTokens: null };
	const num = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) ? v : null;
	const root = json as Record<string, unknown>;
	const usage = (root.usage ?? null) as Record<string, unknown> | null;
	const meta = (root.usageMetadata ?? null) as Record<string, unknown> | null;
	const details = (usage?.prompt_tokens_details ?? null) as
		| Record<string, unknown>
		| null;

	let cached: number | null =
		num(details?.cached_tokens) ??
		num(meta?.cachedContentTokenCount) ??
		null;
	if (cached === null && usage) {
		const read = num(usage.cache_read_input_tokens);
		const creation = num(usage.cache_creation_input_tokens);
		if (read !== null || creation !== null) cached = (read ?? 0) + (creation ?? 0);
	}

	return {
		promptTokens:
			num(usage?.prompt_tokens) ??
			num(usage?.input_tokens) ??
			num(meta?.promptTokenCount),
		completionTokens:
			num(usage?.completion_tokens) ??
			num(usage?.output_tokens) ??
			num(meta?.candidatesTokenCount),
		cachedTokens: cached,
	};
}

function buildStreamResponse(
	upstream: Response,
	options: ExecutorOptions,
	transformer: StreamTransformer,
): Response {
	const started = Date.now();
	let completionTokens = 0;
	let finalized = false;
	let gotFirstByte = false;
	let kaTimer: ReturnType<typeof setInterval> | undefined;
	const dec = new TextDecoder();
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

	const finalize = (
		log: Partial<RequestLog> & Pick<RequestLog, "status">,
	): void => {
		if (finalized) return;
		finalized = true;
		clearInterval(kaTimer);
		try {
			options.signal?.removeEventListener("abort", onClientAbort);
		} catch {
			/* ignore */
		}
		try {
			reader?.cancel().catch(() => undefined);
		} catch {
			/* ignore */
		}
		const usage = options.streamTransformer?.getUsage?.() ?? null;
		options.onComplete({
			duration_ms: Date.now() - started,
			completion_tokens: usage?.completion_tokens ?? completionTokens,
			prompt_tokens: usage?.prompt_tokens ?? null,
			cached_tokens: usage?.cached_tokens ?? null,
			...log,
		});
	};

	const onClientAbort = (): void => {
		finalize({ status: "error", error_message: "client disconnected" });
		try {
			reader?.cancel().catch(() => undefined);
		} catch {
			/* ignore */
		}
	};

	const onUpstreamEnd = (
		controller: ReadableStreamDefaultController<Uint8Array>,
	): void => {
		clearInterval(kaTimer);
		try {
			const rest = transformer.flush();
			if (rest.byteLength > 0) {
				controller.enqueue(rest);
			}
			const term = transformer.terminate?.() ?? EMPTY_BYTES;
			if (term.byteLength > 0) {
				controller.enqueue(term);
			}
			finalize({ status: "success" });
		} catch {
			/* ignore */
		}
		try {
			controller.close();
		} catch {
			/* ignore */
		}
	};

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			kaTimer = setInterval(() => {
				if (gotFirstByte) return;
				try {
					controller.enqueue(KEEP_ALIVE_BYTES);
				} catch {
					/* ignore */
				}
			}, 10_000);

			try {
				reader = upstream.body!.getReader();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				finalize({ status: "error", error_message: message });
				try {
					controller.close();
				} catch {
					/* ignore */
				}
			}
			options.signal?.addEventListener("abort", onClientAbort, { once: true });
		},
		async pull(controller) {
			if (!reader || finalized) return;
			for (;;) {
				if (options.signal?.aborted || finalized) return;
				let read: Awaited<ReturnType<NonNullable<typeof reader>["read"]>>;
				try {
					read = await reader.read();
				} catch (err) {
					if (!options.signal?.aborted && gotFirstByte) {
						try {
							controller.enqueue(DISCONNECT_BYTES);
						} catch {
							/* ignore */
						}
					}
					const message = err instanceof Error ? err.message : String(err);
					finalize({
						status: "error",
						error_message: message || "upstream_disconnect",
					});
					try {
						controller.close();
					} catch {
						/* ignore */
					}
					return;
				}
				if (read.done) {
					onUpstreamEnd(controller);
					return;
				}
				const chunk = read.value;
				if (!gotFirstByte) {
					gotFirstByte = true;
					clearInterval(kaTimer);
				}
				let out: Uint8Array;
				let chunkText: string;
				if (transformer.transformChunk) {
					const r = transformer.transformChunk(chunk);
					out = r.out;
					chunkText = r.text;
				} else {
					out = transformer.transform(chunk);
					chunkText =
						out.byteLength > 0 ? dec.decode(out, { stream: true }) : "";
				}
				completionTokens +=
					transformer.countTokens?.(chunkText) ?? countDeltaContent(chunkText);
				if (out.byteLength > 0) {
					try {
						controller.enqueue(out);
					} catch {
						return;
					}
					if ((controller.desiredSize ?? 0) <= 0) {
						return;
					}
				}
			}
		},
		cancel() {
			finalize({ status: "error", error_message: "client disconnected" });
			try {
				reader?.cancel().catch(() => undefined);
			} catch {
				/* ignore */
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}

export async function executeStreaming(
	options: ExecutorOptions,
): Promise<Response> {
	const started = Date.now();
	const transformer = options.streamTransformer ?? createStreamTransformer();
	const result = await runWithRetry(options);

	if (!result.ok) {
		options.onComplete({
			status: "error",
			error_message: result.detailText,
			duration_ms: Date.now() - started,
		});
		return new Response(SANITIZED_STREAM_ERROR_BODY, {
			status: result.status,
			headers: { "Content-Type": "application/json" },
		});
	}

	return buildStreamResponse(result.response, options, transformer);
}

export type JsonExecutorResult =
	| { ok: true; status: number; json: unknown }
	| { ok: false; status: number; error: string };

export async function executeJson(
	options: ExecutorOptions,
): Promise<JsonExecutorResult> {
	const started = Date.now();
	const result = await runWithRetry(options);

	if (!result.ok) {
		options.onComplete({
			status: "error",
			error_message: result.detailText,
			duration_ms: Date.now() - started,
		});
		return { ok: false, status: result.status, error: result.detailText };
	}

	const text = await result.response.text();
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		options.onComplete({
			status: "error",
			error_message: "invalid upstream json",
			duration_ms: Date.now() - started,
		});
		return { ok: false, status: 502, error: "invalid upstream json" };
	}
	const usage = extractUsage(json);
	options.onComplete({
		status: "success",
		duration_ms: Date.now() - started,
		prompt_tokens: usage.promptTokens,
		completion_tokens: usage.completionTokens,
		cached_tokens: usage.cachedTokens,
	});
	return { ok: true, status: result.response.status, json };
}
