import { describe, expect, test } from "bun:test";
import { build as toOpenAi } from "./to-openai";
import { build as toAnthropic } from "./to-anthropic";
import { build as toGemini } from "./to-gemini";
import type { CanonicalRequest } from "./canonical";

function req(partial: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "m",
    messages: [],
    stream: false,
    extra: {},
    ...partial,
  };
}

describe("to-openai", () => {
  test("round-trips messages, params and tools", () => {
    const body = toOpenAi(
      req({
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.2,
        max_tokens: 50,
        tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
        extra: { seed: 7 },
      }),
    );
    expect(body.model).toBe("m");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(50);
    expect(body.seed).toBe(7);
  });

  test("maps image url and base64 data to image_url parts", () => {
    const body = toOpenAi(
      req({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "t" },
              { type: "image", image_url: "https://x/a.png" },
              { type: "image", data: "QQ==", media_type: "image/png" },
            ],
          },
        ],
      }),
    );
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "t" },
          { type: "image_url", image_url: { url: "https://x/a.png" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } },
        ],
      },
    ]);
  });
});

describe("to-anthropic", () => {
  test("system goes top-level, max_tokens defaults to 4096", () => {
    const body = toAnthropic(
      req({
        messages: [{ role: "system", content: "sys" }],
        stop: ["END"],
      }),
    );
    expect(body.system).toBe("sys");
    expect(body.max_tokens).toBe(4096);
    expect(body.stop_sequences).toEqual(["END"]);
    expect(body.messages).toEqual([]);
  });

  test("assistant tool_calls become tool_use, tool results group into user message", () => {
    const body = toAnthropic(
      req({
        messages: [
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: '{"a":1}' } }],
          },
          { role: "tool", tool_call_id: "t1", content: "ok" },
        ],
      }),
    );
    const messages = body.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(2);
    expect((messages[0].content as Record<string, unknown>[])[0]).toMatchObject({
      type: "tool_use",
      id: "t1",
      name: "f",
      input: { a: 1 },
    });
    expect(messages[1]).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    });
  });
});

describe("to-gemini", () => {
  test("contents roles and generationConfig", () => {
    const body = toGemini(
      req({
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
        max_tokens: 100,
        temperature: 0.5,
      }),
    );
    expect(body.systemInstruction).toEqual({ parts: [{ text: "sys" }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
    expect(body.generationConfig).toEqual({ temperature: 0.5, maxOutputTokens: 100 });
  });

  test("functionCall and functionResponse parts", () => {
    const body = toGemini(
      req({
        messages: [
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"x":1}' } }],
          },
          { role: "tool", tool_call_id: "c1", content: "42" },
        ],
      }),
    );
    const contents = body.contents as Record<string, unknown>[];
    expect((contents[0].parts as Record<string, unknown>[])[0]).toEqual({
      functionCall: { name: "f", args: { x: 1 } },
    });
    expect((contents[1].parts as Record<string, unknown>[])[0]).toEqual({
      functionResponse: { name: "f", response: { result: "42" } },
    });
  });
});
