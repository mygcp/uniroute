import { describe, expect, test } from "bun:test";
import { translateResponse } from "./format-response";

const openAiResponse = {
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "hello",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "f", arguments: '{"a":1}' },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
};

const anthropicResponse = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4",
  content: [
    { type: "text", text: "hi" },
    { type: "tool_use", id: "toolu_1", name: "f", input: { a: 1 } },
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 5, output_tokens: 7 },
};

const geminiResponse = {
  candidates: [
    {
      content: { parts: [{ text: "yo" }, { functionCall: { name: "f", args: { a: 1 } } }] },
      finishReason: "STOP",
    },
  ],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 },
};

describe("openai provider", () => {
  test("→ chat passthrough", () => {
    const out = translateResponse("openai", "openai-chat", openAiResponse);
    expect(out).toEqual(openAiResponse);
  });

  test("→ anthropic", () => {
    const out = translateResponse("openai", "anthropic", openAiResponse) as Record<string, unknown>;
    expect(out.type).toBe("message");
    expect(out.content).toContainEqual({ type: "text", text: "hello" });
    expect(out.content).toContainEqual({ type: "tool_use", id: "call_1", name: "f", input: { a: 1 } });
    expect(out.stop_reason).toBe("tool_use");
    expect(out.usage).toEqual({ input_tokens: 5, output_tokens: 7 });
  });

  test("→ responses", () => {
    const out = translateResponse("openai", "openai-responses", openAiResponse) as Record<string, unknown>;
    expect(out.object).toBe("response");
    const output = out.output as Record<string, unknown>[];
    expect(output[0].content).toEqual([{ type: "output_text", text: "hello" }]);
    expect(output[1]).toMatchObject({ type: "function_call", name: "f", call_id: "call_1" });
  });
});

describe("anthropic provider", () => {
  test("→ chat", () => {
    const out = translateResponse("anthropic", "openai-chat", anthropicResponse) as Record<string, unknown>;
    const choice = (out.choices as Record<string, unknown>[])[0];
    expect(choice.message).toMatchObject({ role: "assistant", content: "hi" });
    expect((choice.message as Record<string, unknown>).tool_calls).toContainEqual({
      id: "toolu_1",
      type: "function",
      function: { name: "f", arguments: '{"a":1}' },
    });
  });

  test("→ responses", () => {
    const out = translateResponse("anthropic", "openai-responses", anthropicResponse) as Record<string, unknown>;
    const output = out.output as Record<string, unknown>[];
    expect(output[0].content).toEqual([{ type: "output_text", text: "hi" }]);
    expect(output[1]).toMatchObject({ type: "function_call", name: "f" });
  });
});

describe("gemini provider", () => {
  test("→ chat", () => {
    const out = translateResponse("gemini", "openai-chat", geminiResponse) as Record<string, unknown>;
    const message = ((out.choices as Record<string, unknown>[])[0].message as Record<string, unknown>);
    expect(message.content).toBe("yo");
    expect(message.tool_calls).toHaveLength(1);
  });

  test("→ anthropic", () => {
    const out = translateResponse("gemini", "anthropic", geminiResponse) as Record<string, unknown>;
    expect(out.content).toContainEqual({ type: "text", text: "yo" });
    expect(out.usage).toEqual({ input_tokens: 5, output_tokens: 7 });
  });
});
