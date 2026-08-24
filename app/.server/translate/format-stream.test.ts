import { describe, expect, test } from "bun:test";
import { composeStreamTransformer } from "./format-stream";

const enc = new TextEncoder();
const dec = new TextDecoder();

function runAll(t: ReturnType<typeof composeStreamTransformer>, chunks: string[]): string {
  let out = "";
  for (const c of chunks) {
    const bytes = t.transform(enc.encode(c));
    if (bytes.byteLength > 0) out += dec.decode(bytes);
  }
  const flush = t.flush();
  if (flush.byteLength > 0) out += dec.decode(flush);
  return out;
}

describe("openai → openai-chat", () => {
  test("streams content delta and [DONE]", () => {
    const t = composeStreamTransformer("openai", "openai-chat");
    const out = runAll(t, [
      'data: {"choices":[{"delta":{"content":"hi"},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{"content":"!"},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(out).toContain('"content":"hi"');
    expect(out).toContain('"content":"!"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out).toContain("data: [DONE]\n\n");
    expect(t.done?.()).toBe(true);
    expect(dec.decode(t.terminate?.() ?? new Uint8Array(0))).toBe("");
  });
});

describe("openai → openai-responses", () => {
  test("emits responses SSE events", () => {
    const t = composeStreamTransformer("openai", "openai-responses");
    const out = runAll(t, [
      'data: {"choices":[{"delta":{"content":"hello"},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n',
    ]);
    expect(out).toContain('"type":"response.output_text.delta"');
    expect(out).toContain('"delta":"hello"');
    expect(out).toContain('"type":"response.completed"');
    expect(dec.decode(t.terminate?.() ?? new Uint8Array(0))).toBe("");
  });
});

describe("anthropic → anthropic", () => {
  test("maps events to anthropic SSE", () => {
    const t = composeStreamTransformer("anthropic", "anthropic");
    const out = runAll(t, [
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"yo"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1,"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    expect(out).toContain('event: message_start');
    expect(out).toContain('"type":"text_delta","text":"yo"');
    expect(out).toContain('"stop_reason":"end_turn"');
    expect(out).toContain('"type":"message_stop"');
    expect(t.done?.()).toBe(true);
  });
});

describe("gemini → openai-chat", () => {
  test("translates gemini text to chat delta", () => {
    const t = composeStreamTransformer("gemini", "openai-chat");
    const out = runAll(t, [
      'data: {"candidates":[{"content":{"parts":[{"text":"hey"}]}}]}\n\n',
      'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2}}\n\n',
    ]);
    expect(out).toContain('"content":"hey"');
    expect(out).toContain('"finish_reason":"STOP"');
    expect(dec.decode(t.terminate?.() ?? new Uint8Array(0))).toBe("data: [DONE]\n\n");
  });
});

describe("terminate fallback", () => {
  test("appends [DONE] for chat when upstream has no done", () => {
    const t = composeStreamTransformer("gemini", "openai-chat");
    const out = runAll(t, ['data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}\n\n']);
    expect(t.done?.()).toBe(false);
    expect(dec.decode(t.terminate?.() ?? new Uint8Array(0))).toBe("data: [DONE]\n\n");
    expect(out).toContain('"content":"x"');
  });

  test("appends message_stop for anthropic client when upstream has no done", () => {
    const t = composeStreamTransformer("gemini", "anthropic");
    runAll(t, ['data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}\n\n']);
    expect(t.done?.()).toBe(false);
    expect(dec.decode(t.terminate?.() ?? new Uint8Array(0))).toContain('"type":"message_stop"');
  });

  test("drops empty content_delta frames (optimasi: tidak diteruskan ke client)", () => {
    const t = composeStreamTransformer("openai", "openai-chat");
    const out = runAll(t, [
      'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n',
      // 3 frame kosong berturut-turut — harus diabaikan semua.
      'data: {"choices":[{"delta":{"content":""},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{"content":""},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{"content":""},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{"content":"hi"},"index":0}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(out).toContain('"content":"hi"');
    expect(out.match(/"content":""/g)).toBeNull();
  });
});
