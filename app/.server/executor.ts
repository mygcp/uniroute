import { createStreamTransformer } from "./adapter";
import { fetchUpstream } from "./proxy-resolver";
import type { RequestLog } from "./logger";
import type { StreamTransformer } from "./translate/canonical";

export type ExecutorOptions = {
	url: string;
	headers: Headers;
	body: string;
	signal?: AbortSignal;
	/** Client API key's proxy pool (highest priority: client key). */
	apiKeyPoolId?: number;
	/** Provider credential's proxy pool (second priority: account). */
	accountPoolId?: number;
	/** Combo's proxy pool (third priority: combo). */
	comboPoolId?: number;
	/** Provider's proxy pool (fourth priority: provider; then global, then direct). */
	providerPoolId?: number;
	/** Provider id, used only for diagnostics. */
	providerId?: string;
	/** Dipanggil saat proxy spesifik terpilih (untuk metadata request log). */
	onProxyUsed?: (info: ProxyUsedInfo | null) => void;
	/** Konteks proxy_logs. */
	logClientIp?: string | null;
	logApiKeyId?: number | null;
	streamTransformer?: StreamTransformer;
	onComplete: (log: Partial<RequestLog> & Pick<RequestLog, "status">) => void;
};

/** Metadata proxy yang dipakai egress — dibawa sekali agar log tidak re-query. */
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
// Encoder bersama — encode() stateless, aman dipakai lintas stream.
const ENCODER = new TextEncoder();

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
		onProxyUsed,
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
		const raw = err instanceof Error ? err.message : String(err);
		const message = raw;
		// Timeout upstream (120s): hampir pasti gagal lagi kalau diulang —
		// jangan buang 2×waktu untuk retry.
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
	const re = /"delta":\{"content":"((?:[^"\\]|\\.)*)"/g;
	let tokens = 0;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		tokens += Math.max(1, Math.ceil(match[1].length / 4));
	}
	return tokens;
}

/**
 * Ekstraksi token usage resmi dari body JSON upstream. Mendukung format
 * openai (`usage.prompt_tokens` + `prompt_tokens_details.cached_tokens`),
 * anthropic (`usage.input_tokens` + cache_read/creation) dan gemini
 * (`usageMetadata.*TokenCount`). Return null bila tidak tersedia.
 */
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

export const UPSTREAM_DISCONNECT_CODE = "upstream_disconnect";

function disconnectMarker(): Uint8Array {
  return ENCODER.encode(
    `data: ${JSON.stringify({ error: { code: UPSTREAM_DISCONNECT_CODE, message: "upstream closed mid-stream" } })}\n\n`,
  );
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
  let forwardedBytes = 0;

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

  let kaTimer: ReturnType<typeof setInterval> | undefined = undefined;
  // Decoder satu instance per stream — mode streaming aman untuk multibyte
  // yang terpotong di batas chunk.
  const dec = new TextDecoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Keep-alive tiap 10s sampai byte pertama upstream datang.
      kaTimer = setInterval(() => {
        if (gotFirstByte) return;
        try {
          controller.enqueue(ENCODER.encode(": keep-alive\n\n"));
        } catch {
          /* ignore */
        }
      }, 10_000);

      const onUpstreamEnd = (clean: boolean): void => {
        clearInterval(kaTimer);
        try {
          if (clean) {
            const rest = transformer.flush();
            if (rest.byteLength > 0) {
              forwardedBytes += rest.byteLength;
              controller.enqueue(rest);
            }
            const term = transformer.terminate?.() ?? new Uint8Array(0);
            if (term.byteLength > 0) {
              forwardedBytes += term.byteLength;
              controller.enqueue(term);
            }
            finalize({ status: "success" });
          }
        } catch {
          /* ignore */
        }
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };

      (async () => {
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
          return;
        }
        for (;;) {
          if (options.signal?.aborted) return; // onClientAbort yang finalize
          let read: Awaited<ReturnType<NonNullable<typeof reader>["read"]>>;
          try {
            read = await reader.read();
          } catch (err) {
            // Putus tengah jalan setelah bytes terkirim → marker eksplisit
            // (tanpa [DONE]) agar client bisa auto-lanjut potongan.
            if (!options.signal?.aborted && gotFirstByte) {
              try {
                controller.enqueue(disconnectMarker());
              } catch {
                /* ignore */
              }
            }
            const message = err instanceof Error ? err.message : String(err);
            finalize({ status: "error", error_message: message || "upstream_disconnect" });
            try {
              controller.close();
            } catch {
              /* ignore */
            }
            return;
          }
          if (read.done) {
            onUpstreamEnd(true);
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
            chunkText = r.text; // frame kontrol punya text → tetap dihitung
          } else {
            out = transformer.transform(chunk);
            chunkText =
              out.byteLength > 0 ? dec.decode(out, { stream: true }) : "";
          }
          completionTokens +=
            transformer.countTokens?.(chunkText) ?? countDeltaContent(chunkText);
          if (out.byteLength > 0) {
            forwardedBytes += out.byteLength;
            try {
              controller.enqueue(out);
            } catch {
              return; // client menutup koneksi
            }
          }
        }
      })().catch((err: unknown) => {
        if (options.signal?.aborted) return; // sudah dicatat onClientAbort
        const message = err instanceof Error ? err.message : String(err);
        finalize({ status: "error", error_message: message });
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      });
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

  // Client putus koneksi → hentikan upstream & catat.
  const onClientAbort = (): void => {
    finalize({ status: "error", error_message: "client disconnected" });
    try {
      reader?.cancel().catch(() => undefined);
    } catch {
      /* ignore */
    }
  };
  options.signal?.addEventListener("abort", onClientAbort, { once: true });

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
		return new Response(result.detailText, {
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
