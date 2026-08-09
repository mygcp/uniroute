import "./test-env";
import { afterAll, describe, expect, test } from "bun:test";
import { createStreamTransformer, transformRequest } from "./adapter";
import { deleteApiKey, setApiKey } from "./credential";
import { exec } from "./db";
import type { Provider } from "./registry";

const TEST_PROVIDER: Provider = {
  id: "test-provider",
  name: "Test",
  base_url: "https://mock.example.com",
  auth_type: "bearer",
  is_active: true,
  weight: 1,
  priority: 1,
  current_connections: 0,
  last_used_at: 0,
};

describe("transformRequest", () => {
  test("builds correct url and headers for bearer provider", () => {
    setApiKey("test-provider", "sk-test-key");
    const { url, headers, body } = transformRequest(
      { model: "gpt-4o", stream: true },
      TEST_PROVIDER,
    );
    expect(url).toBe("https://mock.example.com/v1/chat/completions");
    expect(headers.get("Authorization")).toBe("Bearer sk-test-key");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(body).model).toBe("gpt-4o");
  });

  test("apikey provider uses x-goog-api-key", () => {
    setApiKey("test-apikey", "google-key");
    const { headers } = transformRequest(
      { model: "gemini" },
      { ...TEST_PROVIDER, id: "test-apikey", auth_type: "apikey" },
    );
    expect(headers.get("x-goog-api-key")).toBe("google-key");
    expect(headers.get("Authorization")).toBeNull();
    deleteApiKey("test-apikey");
  });

  test("opencode uses urlSuffix to keep the /zen path and sends no auth header", () => {
    deleteApiKey("opencode");
    const { url, headers } = transformRequest(
      { model: "deepseek-v4-flash-free" },
      {
        ...TEST_PROVIDER,
        id: "opencode",
        base_url: "https://opencode.ai/zen/v1",
        auth_type: "none",
      },
    );
    expect(url).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("x-goog-api-key")).toBeNull();
  });

  test("provider without urlSuffix keeps the fallback /v1/chat/completions URL", () => {
    deleteApiKey("test-provider");
    const { url, headers } = transformRequest(
      { model: "gpt-4o" },
      TEST_PROVIDER,
    );
    expect(url).toBe("https://mock.example.com/v1/chat/completions");
    expect(headers.get("Authorization")).toBeNull();
  });

  test("provider without key has no auth header", () => {
    deleteApiKey("test-provider");
    const { headers } = transformRequest(
      { model: "gpt-4o" },
      { ...TEST_PROVIDER },
    );
    expect(headers.get("Authorization")).toBeNull();
    setApiKey("test-provider", "sk-test");
  });

  afterAll(() => {
    deleteApiKey("test-provider");
    deleteApiKey("test-apikey");
    exec("DELETE FROM provider_credentials WHERE provider_id IN ('test-provider', 'test-apikey')");
  });
});

describe("createStreamTransformer", () => {
  const decode = (bytes: Uint8Array): string =>
    new TextDecoder().decode(bytes);

  test("normalizes delta content into OpenAI single-delta line", () => {
    const t = createStreamTransformer();
    const chunk = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"Hi"},"index":0}]}\n\n',
    );
    const out = decode(t.transform(chunk));
    expect(out).toBe(
      'data: {"choices":[{"delta":{"content":"Hi"},"index":0}]}\n\n',
    );
  });

  test("buffers partial lines until newline completes", () => {
    const t = createStreamTransformer();
    const chunk = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"Hel',
    );
    expect(decode(t.transform(chunk))).toBe("");
    const rest = new TextEncoder().encode(
      'lo"},"index":0}]}\n\n',
    );
    expect(decode(t.transform(rest))).toContain("Hello");
  });

  test("passes through [DONE]", () => {
    const t = createStreamTransformer();
    const out = decode(t.transform(new TextEncoder().encode("data: [DONE]\n\n")));
    expect(out).toBe("data: [DONE]\n\n");
  });

  test("passthrough non-json data lines", () => {
    const t = createStreamTransformer();
    const out = decode(
      t.transform(new TextEncoder().encode("data: ping-pong\n\n")),
    );
    expect(out).toBe("data: ping-pong\n\n");
  });
});