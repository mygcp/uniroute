import { getApiKey } from "./credential";
import { getRegistryEntry } from "~/registry";
import type { Provider } from "./registry";

export type TransformResult = {
  url: string;
  headers: Headers;
  body: string;
};

/**
 * Gabung base_url + path API dengan aman untuk kedua konvensi base_url:
 *  - root style:  https://api.openai.com          → + "/v1/chat/completions"
 *  - full style:  https://api.groq.com/openai/v1  → + "/chat/completions"
 * `new URL(path, base)` TIDAK bisa dipakai di sini: path absolut mengganti
 * seluruh path base, jadi base ber-suffix (…/openai/v1) kehilangan suffix-nya.
 */
export function joinApiUrl(baseUrl: string, apiPath: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = apiPath.replace(/^\/v1(?=\/|$)/, "");
  if (/\/v1$/.test(base)) return base + suffix;
  return base + apiPath;
}

function resolveUrl(
  provider: Provider,
  entry: ReturnType<typeof getRegistryEntry>,
  model?: string,
): string {
  if (entry?.urlSuffix) {
    return `${provider.base_url.replace(/\/+$/, "")}/${entry.urlSuffix}`;
  }
  const base = provider.base_url.replace(/\/+$/, "");
  const format = entry?.format ?? "openai";
  if (format === "anthropic") {
    return joinApiUrl(base, "/v1/messages");
  }
  if (format === "gemini") {
    return `${base}/v1beta/models/${encodeURIComponent(model ?? "")}:generateContent`;
  }
  return joinApiUrl(base, "/v1/chat/completions");
}

export function transformRequest(
  body: Record<string, unknown>,
  provider: Provider,
  opts?: { model?: string; apiKey?: string | null },
): TransformResult {
  const entry = getRegistryEntry(provider.id);
  const url = resolveUrl(provider, entry, opts?.model);
  const headers = new Headers({ "Content-Type": "application/json" });

  const usedKey = opts?.apiKey ?? getApiKey(provider.id);

  if (entry?.authHeader) {
    if (usedKey) {
      headers.set(entry.authHeader, `${entry.authPrefix ?? ""} ${usedKey}`.trim());
    }
  } else if (provider.auth_type === "bearer") {
    if (usedKey) headers.set("Authorization", `Bearer ${usedKey}`);
  } else if (provider.auth_type === "apikey") {
    if (usedKey) headers.set("x-goog-api-key", usedKey);
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