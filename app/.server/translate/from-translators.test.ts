import { describe, expect, test } from "bun:test";
import { parse as parseChat } from "./from-openai-chat";
import { parse as parseResponses } from "./from-responses";
import { parse as parseAnthropic } from "./from-anthropic";

describe("from-openai-chat", () => {
  test("parses basic request", () => {
    const c = parseChat({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "halo" },
      ],
      stream: true,
      temperature: 0.5,
      max_tokens: 100,
      stop: ["END"],
    });
    expect(c.model).toBe("gpt-4o");
    expect(c.messages).toHaveLength(2);
    expect(c.messages[0]).toMatchObject({ role: "system", content: "you are helpful" });
    expect(c.stream).toBe(true);
    expect(c.temperature).toBe(0.5);
    expect(c.max_tokens).toBe(100);
    expect(c.stop).toEqual(["END"]);
  });

  test("maps image_url content and extra passthrough", () => {
    const c = parseChat({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "https://x/y.png" } },
          ],
        },
      ],
      seed: 42,
    });
    expect(c.messages[0].content).toEqual([
      { type: "text", text: "what is this" },
      { type: "image", image_url: "https://x/y.png" },
    ]);
    expect(c.extra.seed).toBe(42);
  });

  test("parses tool_calls and tool results", () => {
    const c = parseChat({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "result" },
      ],
      tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
    });
    expect(c.messages[0].tool_calls?.[0].function.name).toBe("f");
    expect(c.messages[1]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "result" });
    expect(c.tools?.[0].function.description).toBe("d");
  });

  test("throws when model missing", () => {
    expect(() => parseChat({ messages: [] })).toThrow("model required");
  });
});

describe("from-responses", () => {
  test("instructions become system, input string becomes user message", () => {
    const c = parseResponses({
      model: "gpt-4o",
      instructions: "be concise",
      input: "hello",
      max_output_tokens: 200,
    });
    expect(c.messages[0]).toMatchObject({ role: "system", content: "be concise" });
    expect(c.messages[1]).toMatchObject({ role: "user", content: "hello" });
    expect(c.max_tokens).toBe(200);
  });

  test("parses input items with images and function calls", () => {
    const c = parseResponses({
      model: "m",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "look" },
            { type: "input_image", image_url: "https://x/a.png" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "function_call", call_id: "c1", name: "f", arguments: "{\"a\":1}" }],
        },
        {
          role: "tool",
          content: [{ type: "function_call_output", call_id: "c1", output: "42" }],
        },
      ],
    });
    expect(c.messages[0].content).toEqual([
      { type: "text", text: "look" },
      { type: "image", image_url: "https://x/a.png" },
    ]);
    const assistant = c.messages.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls?.[0]).toMatchObject({
      id: "c1",
      function: { name: "f", arguments: '{"a":1}' },
    });
    const tool = c.messages.find((m) => m.role === "tool");
    expect(tool).toMatchObject({ tool_call_id: "c1", content: "42" });
  });

  test("maps responses tools with top-level name", () => {
    const c = parseResponses({
      model: "m",
      input: "hi",
      tools: [{ type: "function", name: "f", description: "d", parameters: { type: "object" } }],
      tool_choice: { type: "function", name: "f" },
    });
    expect(c.tools?.[0].function.name).toBe("f");
    expect(c.tool_choice).toEqual({ type: "function", function: { name: "f" } });
  });
});

describe("from-anthropic", () => {
  test("system string and basic messages", () => {
    const c = parseAnthropic({
      model: "claude-sonnet-4",
      system: "be nice",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      stop_sequences: ["STOP"],
    });
    expect(c.messages[0]).toMatchObject({ role: "system", content: "be nice" });
    expect(c.messages[1]).toMatchObject({ role: "user", content: "hi" });
    expect(c.max_tokens).toBe(100);
    expect(c.stop).toEqual(["STOP"]);
  });

  test("parses content blocks incl images", () => {
    const c = parseAnthropic({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "see" },
            { type: "image", source: { type: "url", url: "https://x/a.png" } },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
          ],
        },
      ],
    });
    expect(c.messages[0].content).toEqual([
      { type: "text", text: "see" },
      { type: "image", image_url: "https://x/a.png" },
      { type: "image", data: "AAA", media_type: "image/png" },
    ]);
  });

  test("parses tool_use and tool_result", () => {
    const c = parseAnthropic({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "f", input: { a: 1 } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
      tools: [{ name: "f", description: "d", input_schema: { type: "object" } }],
    });
    const assistant = c.messages.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls?.[0]).toMatchObject({
      id: "t1",
      function: { name: "f", arguments: '{"a":1}' },
    });
    const tool = c.messages.find((m) => m.role === "tool");
    expect(tool).toMatchObject({ tool_call_id: "t1", content: "ok" });
    expect(c.tools?.[0].function.parameters).toEqual({ type: "object" });
  });
});
