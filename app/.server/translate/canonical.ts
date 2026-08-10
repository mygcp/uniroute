export type CanonicalContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image_url?: string; data?: string; media_type?: string };

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
  | { type: "message_start"; model: string }
  | { type: "content_start" }
  | { type: "content_delta"; text: string }
  | {
      type: "tool_calls_delta";
      id?: string;
      name?: string;
      arguments: string;
    }
  | {
      type: "finish";
      finish_reason: string;
      usage?: { prompt_tokens: number; completion_tokens: number };
    }
  | { type: "done" };

export type ClientFormat = "openai-chat" | "openai-responses" | "anthropic";
export type ProviderFormat = "openai" | "anthropic" | "gemini";

export type StreamTransformer = {
  transform(chunk: Uint8Array): Uint8Array;
  flush(): Uint8Array;
  countTokens?: (chunkText: string) => number;
  done?: () => boolean;
  terminate?: () => Uint8Array;
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
