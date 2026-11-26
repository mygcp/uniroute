import type {
  CanonicalStreamEvent,
  ClientFormat,
  ProviderFormat,
  StreamTransformer,
} from "./canonical";
import { parseFrame, tokenizeSse } from "./parse-stream";

const ENCODER = new TextEncoder();
const EMPTY_BYTES = new Uint8Array(0);
const DONE_BYTES = ENCODER.encode("data: [DONE]\n\n");

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
  const needResponsesIds = clientFormat === "openai-responses";
  const responseId = needResponsesIds ? randomId("resp_") : "";
  const itemId = needResponsesIds ? randomId("msg_") : "";
  const reasonId = needResponsesIds ? randomId("rs_") : "";
  const toolItemId = needResponsesIds ? randomId("fc_") : "";
  let blockIndex = 0;
  let thinkingBlockIndex: number | null = null;
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
    if (ev.type === "reasoning_start") {
      // Blok thinking Anthropic — tanpa signature (display only).
      if (clientFormat === "anthropic" && thinkingBlockIndex === null) {
        thinkingBlockIndex = blockIndex++;
        return frame(
          JSON.stringify({
            type: "content_block_start",
            index: thinkingBlockIndex,
            content_block: { type: "thinking", thinking: "" },
          }),
          "content_block_start",
        );
      }
      return null;
    }
    if (ev.type === "reasoning_delta") {
      if (clientFormat === "openai-chat") {
        // Konvensi DeepSeek/OpenRouter — dibaca Open WebUI & klien sejenis.
        return frame(
          JSON.stringify({
            choices: [{ delta: { reasoning_content: ev.text }, index: 0 }],
          }),
        );
      }
      if (clientFormat === "openai-responses") {
        return frame(
          JSON.stringify({
            type: "response.reasoning_summary_text.delta",
            item_id: reasonId,
            output_index: 0,
            content_index: 0,
            delta: ev.text,
          }),
        );
      }
      if (clientFormat === "anthropic") {
        if (thinkingBlockIndex === null) {
          thinkingBlockIndex = blockIndex++;
          const start = frame(
            JSON.stringify({
              type: "content_block_start",
              index: thinkingBlockIndex,
              content_block: { type: "thinking", thinking: "" },
            }),
            "content_block_start",
          );
          const delta = frame(
            JSON.stringify({
              type: "content_block_delta",
              index: thinkingBlockIndex,
              delta: { type: "thinking_delta", thinking: ev.text },
            }),
            "content_block_delta",
          );
          return start + delta;
        }
        return frame(
          JSON.stringify({
            type: "content_block_delta",
            index: thinkingBlockIndex,
            delta: { type: "thinking_delta", thinking: ev.text },
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

export function composeStreamTransformer(
  providerFormat: ProviderFormat,
  clientFormat: ClientFormat,
): StreamTransformer {
  const format = createEventFormatter(clientFormat);
  let pending = "";
  let streamDone = false;
  let sawFinish = false;
  let startPrompt: number | null = null;
  let startCached: number | null = null;
  let lastChunkTokens = 0;
  let lastUsage: {
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens?: number;
  } | null = null;
  const dec = new TextDecoder();

  const process = (input: Uint8Array, rest: string): { out: string; rest: string; tokens: number } => {
    const { frames, rest: r } = tokenizeSse(input, rest, dec);
    let out = "";
    let tokens = 0;
    for (const frameText of frames) {
      const ev = parseFrame(providerFormat, frameText);
      if (!ev) continue;
      if (ev.type === "content_delta" && ev.text === "") continue;
      if (ev.type === "reasoning_delta" && ev.text === "") continue;
      if (ev.type === "content_delta" || ev.type === "reasoning_delta") {
        tokens += Math.max(1, Math.ceil(ev.text.length / 4));
      } else if (ev.type === "tool_calls_delta" && ev.arguments) {
        tokens += Math.max(1, Math.ceil(ev.arguments.length / 4));
      }
      if (ev.type === "done") streamDone = true;
      if (ev.type === "finish" && ev.finish_reason !== "") sawFinish = true;
      if (ev.type === "message_start" && ev.usage) {
        startPrompt = ev.usage.prompt_tokens;
        startCached = ev.usage.cached_tokens ?? null;
      }
      if (ev.type === "finish") {
        if (ev.usage) {
          lastUsage = {
            prompt_tokens: ev.usage.prompt_tokens ?? startPrompt ?? 0,
            completion_tokens: ev.usage.completion_tokens ?? 0,
            ...((ev.usage.cached_tokens ?? startCached) != null
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
      if (ev.type === "finish" && ev.finish_reason === "") continue;
      const s = format(ev);
      if (s) out += s;
    }
    return { out, rest: r, tokens };
  };

  return {
    transform(chunk: Uint8Array): Uint8Array {
      const { out, rest, tokens } = process(chunk, pending);
      pending = rest;
      lastChunkTokens = tokens;
      if (out === "") return EMPTY_BYTES;
      return ENCODER.encode(out);
    },
    transformChunk(
      chunk: Uint8Array,
    ): { out: Uint8Array; text: string } {
      const { out, rest, tokens } = process(chunk, pending);
      pending = rest;
      lastChunkTokens = tokens;
      return {
        out: out === "" ? EMPTY_BYTES : ENCODER.encode(out),
        text: out,
      };
    },
    flush(): Uint8Array {
      const { out, rest, tokens } = process(EMPTY_BYTES, pending);
      pending = rest;
      lastChunkTokens = tokens;
      return out === "" ? EMPTY_BYTES : ENCODER.encode(out);
    },
    countTokens(): number {
      const n = lastChunkTokens;
      lastChunkTokens = 0;
      return n;
    },
    done(): boolean {
      return streamDone || sawFinish;
    },
    getUsage() {
      return lastUsage;
    },
    terminate(): Uint8Array {
      if (streamDone) return EMPTY_BYTES;
      if (clientFormat === "openai-responses") return EMPTY_BYTES;
      if (clientFormat === "openai-chat") return DONE_BYTES;
      return ENCODER.encode(
        frame(JSON.stringify({ type: "message_stop" }), "message_stop"),
      );
    },
  };
}
