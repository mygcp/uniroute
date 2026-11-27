export type CanonicalContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image_url?: string; data?: string; media_type?: string }
  | { type: "audio"; data: string; format?: string };

export type CanonicalMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | CanonicalContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
};

export type CanonicalTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type CanonicalRequest = {
  model: string;
  messages: CanonicalMessage[];
  stream: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  tools?: CanonicalTool[];
  tool_choice?: unknown;
  extra: Record<string, unknown>;
};

export type CanonicalStreamEvent =
  | {
      type: "message_start";
      model: string;
      /** Prompt/cache awal (anthropic mengirimnya di message_start). */
      usage?: { prompt_tokens: number; cached_tokens?: number };
    }
  | { type: "content_start" }
  | { type: "content_delta"; text: string }
  /** Progressive reasoning/thinking output (never mixed into answer text). */
  | { type: "reasoning_delta"; text: string }
  /** A thinking block opened (anthropic `thinking` content_block_start). */
  | { type: "reasoning_start" }
  | {
      type: "tool_calls_delta";
      id?: string;
      name?: string;
      arguments: string;
    }
  | {
      type: "finish";
      finish_reason: string;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        cached_tokens?: number;
      };
    }
  | { type: "done" };

export type ClientFormat = "openai-chat" | "openai-responses" | "anthropic";
export type ProviderFormat = "openai" | "anthropic" | "gemini";

export type StreamTransformer = {
  transform(chunk: Uint8Array): Uint8Array;
  flush(): Uint8Array;
  /** Decode once: returns bytes and text for reuse. */
  transformChunk?: (
    chunk: Uint8Array,
  ) => { out: Uint8Array; text: string };
  countTokens?: (chunkText: string) => number;
  done?: () => boolean;
  terminate?: () => Uint8Array;
  /** Official usage from provider `finish` event, if present. */
  getUsage?:
    | (() => {
        prompt_tokens: number;
        completion_tokens: number;
        cached_tokens?: number;
      } | null)
    | undefined;
};

export function messageText(message: CanonicalMessage): string | null {
  if (typeof message.content === "string") return message.content;
  if (
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every((p) => p.type === "text")
  ) {
    return message.content
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
  }
  return null;
}

export function extractMessageTextAll(message: CanonicalMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  let out = "";
  for (const part of message.content) {
    if (part.type === "text" && part.text) {
      out += (out ? "\n" : "") + part.text;
    }
  }
  return out;
}

const RESERVED_EXTRA_KEYS = new Set([
  "model",
  "messages",
  "system",
  "contents",
  "systemInstruction",
  "generationConfig",
  "stream",
  "tools",
  "tool_choice",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "input",
  "instructions",
  "temperature",
  "top_p",
  "stop",
  "stop_sequences",
  "__proto__",
  "constructor",
  "prototype",
]);

export function sanitizeExtra(
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!extra) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (RESERVED_EXTRA_KEYS.has(k) || v === undefined) continue;
    if (k === "n") {
      if (typeof v === "number" && Number.isFinite(v)) {
        out.n = Math.min(8, Math.max(1, Math.floor(v)));
      }
      continue;
    }
    out[k] = v;
  }
  return out;
}
