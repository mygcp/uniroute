import { describe, expect, test } from "bun:test";
import { parseFrame, tokenizeSse } from "./parse-stream";

describe("tokenizeSse", () => {
  test("splits frames across chunk boundaries", () => {
    const enc = new TextEncoder();
    const sse = "data: {\"a\":1}\n\ndata: {\"b\":2}\n\n";
    const half = Math.ceil(sse.length / 2);
    const first = tokenizeSse(enc.encode(sse.slice(0, half)));
    expect(first.frames).toHaveLength(1);
    const second = tokenizeSse(enc.encode(sse.slice(half)), first.rest);
    expect(second.frames).toHaveLength(1);
    expect(second.rest).toBe("");
  });
});

describe("parseFrame openai", () => {
  test("content delta", () => {
    const ev = parseFrame("openai", '{"choices":[{"delta":{"content":"hi"},"index":0}]}');
    expect(ev).toEqual({ type: "content_delta", text: "hi" });
  });

  test("tool call delta", () => {
    const ev = parseFrame(
      "openai",
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"f","arguments":"{\\"a\\""}}]},"index":0}]}',
    );
    expect(ev).toMatchObject({ type: "tool_calls_delta", id: "c1", name: "f" });
  });

  test("finish with usage", () => {
    const ev = parseFrame(
      "openai",
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}',
    );
    expect(ev).toEqual({
      type: "finish",
      finish_reason: "stop",
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
  });

  test("done marker", () => {
    expect(parseFrame("openai", "[DONE]")).toEqual({ type: "done" });
  });
});

describe("parseFrame anthropic", () => {
  test("message_start", () => {
    const ev = parseFrame("anthropic", '{"type":"message_start","message":{"model":"claude"}}');
    expect(ev).toEqual({ type: "message_start", model: "claude" });
  });

  test("text delta", () => {
    const ev = parseFrame(
      "anthropic",
      '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"yo"}}',
    );
    expect(ev).toEqual({ type: "content_delta", text: "yo" });
  });

  test("tool_use start and input_json_delta", () => {
    const start = parseFrame(
      "anthropic",
      '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"f","input":{}}}',
    );
    expect(start).toMatchObject({ type: "tool_calls_delta", id: "t1", name: "f" });
    const delta = parseFrame(
      "anthropic",
      '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":"}}',
    );
    expect(delta).toEqual({ type: "tool_calls_delta", arguments: '{"a":' });
  });

  test("message_delta and message_stop", () => {
    const delta = parseFrame(
      "anthropic",
      '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":3,"output_tokens":4}}',
    );
    expect(delta).toEqual({
      type: "finish",
      finish_reason: "end_turn",
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
    expect(parseFrame("anthropic", '{"type":"message_stop"}')).toEqual({ type: "done" });
  });
});

describe("parseFrame gemini", () => {
  test("text part", () => {
    const ev = parseFrame(
      "gemini",
      '{"candidates":[{"content":{"parts":[{"text":"hey"}]}}]}',
    );
    expect(ev).toEqual({ type: "content_delta", text: "hey" });
  });

  test("functionCall part", () => {
    const ev = parseFrame(
      "gemini",
      '{"candidates":[{"content":{"parts":[{"functionCall":{"name":"f","args":{"x":1}}}]}}]}',
    );
    expect(ev).toEqual({ type: "tool_calls_delta", name: "f", arguments: '{"x":1}' });
  });

  test("finish with usage", () => {
    const ev = parseFrame(
      "gemini",
      '{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":6}}',
    );
    expect(ev).toEqual({
      type: "finish",
      finish_reason: "STOP",
      usage: { prompt_tokens: 5, completion_tokens: 6 },
    });
  });
});
