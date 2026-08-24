import type {
  CanonicalStreamEvent,
  ClientFormat,
  ProviderFormat,
  StreamTransformer,
} from "./canonical";
import { parseFrame, tokenizeSse } from "./parse-stream";

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}${hex}`;
}

function frame(body: string, event?: string): string {
  return event ? `event: ${event}\ndata: ${body}\n\n` : `data: ${body}\n\n`;
}

export function createEventFormatter(
  clientFormat: ClientFormat,
): (ev: CanonicalStreamEvent) => string | null {
  const responseId = randomId("resp_");
  const itemId = randomId("msg_");
  const toolItemId = randomId("fc_");
  let blockIndex = 0;
  let finished = false;
  let finalUsage: { prompt_tokens: number; completion_tokens: number } | undefined;

  return (ev) => {
    if (ev.type === "done") {
      finished = true;
      if (clientFormat === "openai-chat") return "data: [DONE]\n\n";
      if (clientFormat === "anthropic") {
        return frame(JSON.stringify({ type: "message_stop" }), "message_stop");
      }
      return null;
    }
    if (ev.type === "message_start") {
      if (clientFormat === "openai-responses") {
        return frame(
          JSON.stringify({
            type: "response.created",
            response: {
              id: responseId,
              object: "response",
              created_at: Math.floor(Date.now() / 1000),
              status: "in_progress",
              model: ev.model,
              output: [],
            },
          }),
        );
      }
      if (clientFormat === "anthropic") {
        return frame(
          JSON.stringify({
            type: "message_start",
            message: {
              id: randomId("msg_"),
              type: "message",
              role: "assistant",
              model: ev.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          }),
          "message_start",
        );
      }
      return null;
    }
    if (ev.type === "content_start") {
      if (clientFormat === "anthropic") {
        const idx = blockIndex++;
        return frame(
          JSON.stringify({
            type: "content_block_start",
            index: idx,
            content_block: { type: "text", text: "" },
          }),
          "content_block_start",
        );
      }
      if (clientFormat === "openai-responses") {
        const added = frame(
          JSON.stringify({
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: itemId,
              type: "message",
              role: "assistant",
              status: "in_progress",
              content: [],
            },
          }),
        );
        const partAdded = frame(
          JSON.stringify({
            type: "response.content_part.added",
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "" },
          }),
        );
        return added + partAdded;
      }
      return null;
    }
    if (ev.type === "content_delta") {
      if (clientFormat === "openai-chat") {
        return frame(
          JSON.stringify({
            choices: [{ delta: { content: ev.text }, index: 0 }],
          }),
        );
      }
      if (clientFormat === "openai-responses") {
        return frame(
          JSON.stringify({
            type: "response.output_text.delta",
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            delta: ev.text,
          }),
        );
      }
      if (clientFormat === "anthropic") {
        return frame(
          JSON.stringify({
            type: "content_block_delta",
            index: Math.max(0, blockIndex - 1),
            delta: { type: "text_delta", text: ev.text },
          }),
          "content_block_delta",
        );
      }
      return null;
    }
    if (ev.type === "tool_calls_delta") {
      if (ev.name !== undefined && ev.id !== undefined) {
        if (clientFormat === "anthropic") {
          const idx = blockIndex++;
          return frame(
            JSON.stringify({
              type: "content_block_start",
              index: idx,
              content_block: {
                type: "tool_use",
                id: ev.id,
                name: ev.name,
                input: {},
              },
            }),
            "content_block_start",
          );
        }
      }
      if (clientFormat === "openai-chat") {
        return frame(
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      ...(ev.id !== undefined ? { id: ev.id } : {}),
                      function: {
                        ...(ev.name !== undefined ? { name: ev.name } : {}),
                        arguments: ev.arguments,
                      },
                    },
                  ],
                },
                index: 0,
              },
            ],
          }),
        );
      }
      if (clientFormat === "openai-responses") {
        if (ev.name !== undefined) {
          return frame(
            JSON.stringify({
              type: "response.function_call_arguments.delta",
              item_id: toolItemId,
              output_index: 0,
              delta: "",
            }),
          );
        }
        return frame(
          JSON.stringify({
            type: "response.function_call_arguments.delta",
            item_id: toolItemId,
            output_index: 0,
            delta: ev.arguments,
          }),
        );
      }
      if (clientFormat === "anthropic") {
        return frame(
          JSON.stringify({
            type: "content_block_delta",
            index: Math.max(0, blockIndex - 1),
            delta: { type: "input_json_delta", partial_json: ev.arguments },
          }),
          "content_block_delta",
        );
      }
      return null;
    }
    if (ev.type === "finish") {
      finished = true;
      finalUsage = ev.usage;
      if (clientFormat === "openai-chat") {
        return frame(
          JSON.stringify({
            choices: [{ delta: {}, index: 0, finish_reason: ev.finish_reason }],
          }),
        );
      }
      if (clientFormat === "openai-responses") {
        return frame(
          JSON.stringify({
            type: "response.completed",
            response: {
              id: responseId,
              object: "response",
              created_at: Math.floor(Date.now() / 1000),
              status: "completed",
              model: "",
              output: [],
              ...(finalUsage
                ? {
                    usage: {
                      input_tokens: finalUsage.prompt_tokens,
                      output_tokens: finalUsage.completion_tokens,
                      total_tokens: finalUsage.prompt_tokens + finalUsage.completion_tokens,
                    },
                  }
                : {}),
            },
          }),
        );
      }
      if (clientFormat === "anthropic") {
        return frame(
          JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: ev.finish_reason },
            usage: {
              output_tokens: ev.usage?.completion_tokens ?? 0,
            },
          }),
          "message_delta",
        );
      }
      return null;
    }
    return null;
  };
}

export function formatEvent(
  clientFormat: ClientFormat,
  ev: CanonicalStreamEvent,
): string | null {
  return createEventFormatter(clientFormat)(ev);
}

function countTokensFor(clientFormat: ClientFormat, text: string): number {
  const re =
    clientFormat === "anthropic"
      ? /"text":"((?:[^"\\]|\\.)*)"/g
      : /"content":"((?:[^"\\]|\\.)*)"/g;
  let tokens = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    tokens += Math.max(1, Math.ceil(match[1].length / 4));
  }
  return tokens;
}

export function composeStreamTransformer(
  providerFormat: ProviderFormat,
  clientFormat: ClientFormat,
): StreamTransformer {
  const format = createEventFormatter(clientFormat);
  let pending = "";
  let streamDone = false;
  let startPrompt: number | null = null;
  let startCached: number | null = null;
  let lastUsage: {
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens?: number;
  } | null = null;
  const enc = new TextEncoder();
  // Decoder milik instance ini — aman untuk banyak stream paralel.
  const dec = new TextDecoder();

  const process = (input: Uint8Array, rest: string): { out: string; rest: string } => {
    const { frames, rest: r } = tokenizeSse(input, rest, dec);
    let out = "";
    for (const frameText of frames) {
      const ev = parseFrame(providerFormat, frameText);
      if (!ev) continue;
      // Delta teks kosong membawa nol informasi — jangan diformat/dikirim.
      // Upstream tertentu mengirim puluhan frame ini per stream.
      if (ev.type === "content_delta" && ev.text === "") continue;
      if (ev.type === "done") streamDone = true;
      // Kumpulkan usage dari seluruh aliran:
      if (ev.type === "message_start" && ev.usage) {
        startPrompt = ev.usage.prompt_tokens;
        startCached = ev.usage.cached_tokens ?? null;
      }
      if (ev.type === "finish") {
        if (ev.usage) {
          lastUsage = {
            prompt_tokens: ev.usage.prompt_tokens ?? startPrompt ?? 0,
            completion_tokens: ev.usage.completion_tokens ?? 0,
            ...( (ev.usage.cached_tokens ?? startCached) != null
              ? { cached_tokens: ev.usage.cached_tokens ?? startCached! }
              : {}),
          };
        } else if (startPrompt != null && lastUsage === null) {
          lastUsage = {
            prompt_tokens: startPrompt,
            completion_tokens: 0,
            ...(startCached != null ? { cached_tokens: startCached } : {}),
          };
        }
      }
      // Finish sentinel khusus-usage (finish_reason kosong dari chunk
      // usage-only OpenAI): usage sudah dicatat di atas, jangan diformat.
      if (ev.type === "finish" && ev.finish_reason === "") continue;
      const s = format(ev);
      if (s) out += s;
    }
    return { out, rest: r };
  };

  return {
    transform(chunk: Uint8Array): Uint8Array {
      const { out, rest } = process(chunk, pending);
      pending = rest;
      if (out === "") return enc.encode("");
      return enc.encode(out);
    },
    /**
     * Versi hemat: hasil bytes + teks ter-dekode dalam satu kali decode —
     * executor memakai ini agar tidak mendekode ulang untuk hitung token.
     */
    transformChunk(
      chunk: Uint8Array,
    ): { out: Uint8Array; text: string } {
      const { out, rest } = process(chunk, pending);
      pending = rest;
      return {
        out: out === "" ? enc.encode("") : enc.encode(out),
        text: out,
      };
    },
    flush(): Uint8Array {
      const { out, rest } = process(new Uint8Array(0), pending);
      pending = rest;
      return out === "" ? enc.encode("") : enc.encode(out);
    },
    countTokens(text: string): number {
      return countTokensFor(clientFormat, text);
    },
    done(): boolean {
      return streamDone;
    },
    getUsage() {
      return lastUsage;
    },
    terminate(): Uint8Array {
      if (streamDone) return enc.encode("");
      if (clientFormat === "openai-responses") return enc.encode("");
      if (clientFormat === "openai-chat") return enc.encode("data: [DONE]\n\n");
      return enc.encode(
        frame(JSON.stringify({ type: "message_stop" }), "message_stop"),
      );
    },
  };
}
