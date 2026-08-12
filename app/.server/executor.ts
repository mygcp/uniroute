import { createStreamTransformer } from "./adapter";
import type { RequestLog } from "./logger";
import type { StreamTransformer } from "./translate/canonical";

export type ExecutorOptions = {
  url: string;
  headers: Headers;
  body: string;
  signal?: AbortSignal;
  streamTransformer?: StreamTransformer;
  onComplete: (
    log: Partial<RequestLog> & Pick<RequestLog, "status">,
  ) => void;
};

type AttemptResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; detailText: string; retryable: boolean };

const EXECUTE_TIMEOUT_MS = 120_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function attempt(options: ExecutorOptions): Promise<AttemptResult> {
  const { url, headers, body, signal } = options;
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort();
  signal?.addEventListener("abort", abortFromCaller);

  try {
    const upstream = await fetch(
      url,
      {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.any([
          AbortSignal.timeout(EXECUTE_TIMEOUT_MS),
          controller.signal,
        ]),
      },
    );

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
    return {
      ok: false,
      status: 502,
      detailText: JSON.stringify({ error: { message } }),
      retryable: true,
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

function buildStreamResponse(
  upstream: Response,
  options: ExecutorOptions,
  transformer: StreamTransformer,
): Response {
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort();
  options.signal?.addEventListener("abort", abortFromCaller);
  const started = Date.now();
  const reader = upstream.body!.getReader();
  let completionTokens = 0;
  let finalized = false;

  const finalize = (
    log: Partial<RequestLog> & Pick<RequestLog, "status">,
  ): void => {
    if (finalized) return;
    finalized = true;
    options.onComplete({
      duration_ms: Date.now() - started,
      completion_tokens: completionTokens,
      ...log,
    });
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(wsController) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const output = transformer.transform(value);
          if (output.byteLength === 0) continue;
          const text = new TextDecoder().decode(output);
          completionTokens +=
            transformer.countTokens?.(text) ?? countDeltaContent(text);
          wsController.enqueue(output);
        }
        const rest = transformer.flush();
        if (rest.byteLength > 0) wsController.enqueue(rest);
        const term = transformer.terminate?.() ?? new Uint8Array(0);
        if (term.byteLength > 0) wsController.enqueue(term);
        wsController.close();
        finalize({ status: "success" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        finalize({ status: "error", error_message: message });
        try {
          wsController.error(err);
        } catch {
          /* already closed */
        }
      } finally {
        reader.releaseLock();
        controller.abort();
        options.signal?.removeEventListener("abort", abortFromCaller);
      }
    },
    cancel() {
      finalize({ status: "error", error_message: "client disconnected" });
      controller.abort();
      options.signal?.removeEventListener("abort", abortFromCaller);
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
  options.onComplete({
    status: "success",
    duration_ms: Date.now() - started,
  });
  return { ok: true, status: result.response.status, json };
}
