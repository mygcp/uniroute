import type { CanonicalStreamEvent, ProviderFormat } from "./canonical";

const encoder = new TextEncoder();

export function tokenizeSse(
  input: Uint8Array,
  pending: string,
  decoder: TextDecoder,
): { frames: string[]; rest: string } {
  let text = pending + decoder.decode(input, { stream: true });
  // Normalisasi CRLF (beberapa provider memakai \r\n\r\n sebagai pemisah frame).
  if (text.includes("\r")) text = text.replaceAll("\r\n", "\n");
  const parts = text.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames: string[] = [];
  for (const part of parts) {
    const dataLines = part.split("\n").filter((l) => l.startsWith("data:"));
    const payload = dataLines
      .map((l) => l.slice(5).trimStart())
      .join("\n")
      .trim();
    frames.push(payload);
  }
  return { frames, rest };
}

function parseOpenAi(json: Record<string, unknown>): CanonicalStreamEvent | null {
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  if (!choice) return usageOnlyEvent(json);
  const delta = (choice.delta ?? {}) as Record<string, unknown>;
  if (typeof delta.content === "string") {
    return { type: "content_delta", text: delta.content };
  }
  if (Array.isArray(delta.tool_calls)) {
    const tc = delta.tool_calls[0] as Record<string, unknown> | undefined;
    if (tc) {
      const fn = (tc.function ?? {}) as Record<string, unknown>;
      return {
        type: "tool_calls_delta",
        id: typeof tc.id === "string" ? tc.id : undefined,
        name: typeof fn.name === "string" ? fn.name : undefined,
        arguments: typeof fn.arguments === "string" ? fn.arguments : "",
      };
    }
  }
  if (typeof choice.finish_reason === "string") {
    return openAiFinish(choice.finish_reason, json);
  }
  return usageOnlyEvent(json);
}

/** Bangun event finish dari payload usage OpenAI (cached bila ada). */
function openAiFinish(
  finishReason: string,
  json: Record<string, unknown>,
): CanonicalStreamEvent {
  const usage = json.usage as Record<string, unknown> | undefined;
  const details = (usage?.prompt_tokens_details ?? null) as
    | Record<string, unknown>
    | null;
  const cached =
    typeof details?.cached_tokens === "number" ? details.cached_tokens : undefined;
  const usageOut =
    usage &&
    typeof usage.prompt_tokens === "number" &&
    typeof usage.completion_tokens === "number"
      ? {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          ...(cached !== undefined ? { cached_tokens: cached } : {}),
        }
      : undefined;
  return {
    type: "finish",
    finish_reason: finishReason,
    usage: usageOut,
  };
}

/** Chunk tanpa choices tapi membawa usage → finish kosong khusus usage. */
function usageOnlyEvent(
  json: Record<string, unknown>,
): CanonicalStreamEvent | null {
  const usage = json.usage as Record<string, unknown> | undefined;
  if (
    usage &&
    typeof usage.prompt_tokens === "number" &&
    typeof usage.completion_tokens === "number"
  ) {
    return openAiFinish("", json);
  }
  return null;
}


function parseAnthropic(json: Record<string, unknown>): CanonicalStreamEvent | null {
  const type = json.type;
  if (type === "message_start") {
    const message = (json.message ?? {}) as Record<string, unknown>;
    const usage = (message.usage ?? null) as Record<string, unknown> | null;
    const input = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
    const cacheRead =
      typeof usage?.cache_read_input_tokens === "number"
        ? usage.cache_read_input_tokens
        : 0;
    const cacheCreate =
      typeof usage?.cache_creation_input_tokens === "number"
        ? usage.cache_creation_input_tokens
        : 0;
    return {
      type: "message_start",
      model: typeof message.model === "string" ? message.model : "",
      usage:
        input > 0 || cacheRead > 0 || cacheCreate > 0
          ? {
              prompt_tokens: input + cacheRead + cacheCreate,
              cached_tokens: cacheRead + cacheCreate || undefined,
            }
          : undefined,
    };
  }
  if (type === "content_block_start") {
    const block = (json.content_block ?? {}) as Record<string, unknown>;
    if (block.type === "tool_use") {
      return {
        type: "tool_calls_delta",
        id: typeof block.id === "string" ? block.id : undefined,
        name: typeof block.name === "string" ? block.name : undefined,
        arguments: "",
      };
    }
    return { type: "content_start" };
  }
  if (type === "content_block_delta") {
    const delta = (json.delta ?? {}) as Record<string, unknown>;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      return { type: "content_delta", text: delta.text };
    }
    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      return { type: "tool_calls_delta", arguments: delta.partial_json };
    }
    return null;
  }
  if (type === "message_delta") {
    const delta = (json.delta ?? {}) as Record<string, unknown>;
    const usage = json.usage as Record<string, unknown> | undefined;
    return {
      type: "finish",
      finish_reason: typeof delta.stop_reason === "string" ? delta.stop_reason : "stop",
      usage:
        usage && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number"
          ? {
              prompt_tokens: usage.input_tokens,
              completion_tokens: usage.output_tokens,
              cached_tokens:
                (typeof usage.cache_read_input_tokens === "number"
                  ? usage.cache_read_input_tokens
                  : 0) +
                (typeof usage.cache_creation_input_tokens === "number"
                  ? usage.cache_creation_input_tokens
                  : 0) ||
                undefined,
            }
          : undefined,
    };
  }
  if (type === "message_stop") return { type: "done" };
  return null;
}

function parseGemini(json: Record<string, unknown>): CanonicalStreamEvent | null {
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const candidate = candidates[0] as Record<string, unknown> | undefined;
  if (!candidate) return null;
  const content = (candidate.content ?? {}) as Record<string, unknown>;
  const parts = Array.isArray(content.parts) ? content.parts : [];
  for (const raw of parts) {
    const part = raw as Record<string, unknown>;
    if (typeof part.text === "string") {
      return { type: "content_delta", text: part.text };
    }
    if (part.functionCall && typeof part.functionCall === "object") {
      const fc = part.functionCall as Record<string, unknown>;
      let args = "";
      try {
        args = JSON.stringify(fc.args ?? {});
      } catch {
        args = "";
      }
      return {
        type: "tool_calls_delta",
        name: typeof fc.name === "string" ? fc.name : undefined,
        arguments: args,
      };
    }
  }
  if (typeof candidate.finishReason === "string") {
    const meta = json.usageMetadata as Record<string, unknown> | undefined;
    return {
      type: "finish",
      finish_reason: candidate.finishReason,
      usage:
        meta && typeof meta.promptTokenCount === "number" && typeof meta.candidatesTokenCount === "number"
          ? {
              prompt_tokens: meta.promptTokenCount,
              completion_tokens: meta.candidatesTokenCount,
              cached_tokens:
                typeof meta.cachedContentTokenCount === "number"
                  ? meta.cachedContentTokenCount
                  : undefined,
            }
          : undefined,
    };
  }
  return null;
}

export function parseFrame(
  format: ProviderFormat,
  frame: string,
): CanonicalStreamEvent | null {
  const trimmed = frame.trim();
  if (trimmed === "" || trimmed === "data:") return null;
  if (trimmed === "[DONE]") return { type: "done" };
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  switch (format) {
    case "openai":
      return parseOpenAi(json);
    case "anthropic":
      return parseAnthropic(json);
    case "gemini":
      return parseGemini(json);
  }
}
