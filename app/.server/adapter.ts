import { getApiKey } from "./credential";
import type { Provider } from "./registry";

export type TransformResult = {
  url: string;
  headers: Headers;
  body: string;
};

export function transformRequest(
  body: Record<string, unknown>,
  provider: Provider,
): TransformResult {
  const url = new URL("/v1/chat/completions", provider.base_url).toString();
  const headers = new Headers({ "Content-Type": "application/json" });

  if (provider.auth_type === "bearer") {
    const key = getApiKey(provider.id);
    if (key) headers.set("Authorization", `Bearer ${key}`);
  } else if (provider.auth_type === "apikey") {
    const key = getApiKey(provider.id);
    if (key) headers.set("x-goog-api-key", key);
  }

  return { url, headers, body: JSON.stringify(body) };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type SseChunk = {
  choices?: { delta?: { content?: string }; text?: string }[];
  done?: boolean;
};

export function createStreamTransformer() {
  let pending = "";

  function transform(chunk: Uint8Array): Uint8Array {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    const out: string[] = [];
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const normalized = transformLine(line);
      if (normalized) out.push(normalized);
    }
    if (out.length === 0) return encoder.encode("");
    return encoder.encode(out.join(""));
  }

  function transformLine(line: string): string {
    const data = line.startsWith("data:") ? line.slice(5) : line;
    const trimmed = data.trim();
    if (trimmed === "[DONE]") return "data: [DONE]\n\n";
    if (trimmed === "") return "";
    if (!trimmed.startsWith("{")) return `data: ${trimmed}\n\n`;
    try {
      const parsed = JSON.parse(trimmed) as SseChunk;
      const delta = parsed.choices?.[0]?.delta;
      if (typeof delta?.content === "string") {
        return `data: ${JSON.stringify({
          choices: [{ delta: { content: delta.content }, index: 0 }],
        })}\n\n`;
      }
      if (typeof parsed.choices?.[0]?.text === "string") {
        return `data: ${JSON.stringify({
          choices: [{ delta: { content: parsed.choices[0].text }, index: 0 }],
        })}\n\n`;
      }
      return `data: ${trimmed}\n\n`;
    } catch {
      return `data: ${trimmed}\n\n`;
    }
  }

  function flush(): Uint8Array {
    if (pending.trim() === "") return encoder.encode("");
    const out = transformLine(pending);
    pending = "";
    return encoder.encode(out);
  }

  return { transform, flush };
}

export function transformStreamChunk(chunk: Uint8Array): Uint8Array {
  return createStreamTransformer().transform(chunk);
}