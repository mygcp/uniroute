import { describe, expect, test } from "bun:test";
import { parse } from "./from-openai-chat";
import { toProvider } from "./index";
import type { CanonicalRequest } from "./canonical";

const OPENAI_AUDIO_MSG = {
  model: "gpt-4o-audio-preview",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this clip?" },
        { type: "input_audio", input_audio: { data: "QUJD", format: "mp3" } },
      ],
    },
  ],
};

describe("audio parts", () => {
  test("openai-chat input_audio → canonical audio part", () => {
    const c = parse(OPENAI_AUDIO_MSG as never);
    const content = c.messages[0]!.content as CanonicalRequest["messages"][0]["content"];
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string; data?: string; format?: string }>;
    expect(parts.some((p) => p.type === "audio" && p.data === "QUJD" && p.format === "mp3")).toBe(
      true,
    );
  });

  test("canonical audio → openai provider format", () => {
    const c = parse(OPENAI_AUDIO_MSG as never);
    const out = toProvider("openai", c) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const part = out.messages[0]!.content[1]!;
    expect(part).toEqual({
      type: "input_audio",
      input_audio: { data: "QUJD", format: "mp3" },
    });
  });

  test("canonical audio → gemini inlineData", () => {
    const c = parse(OPENAI_AUDIO_MSG as never);
    const out = toProvider("gemini", c) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    const inline = out.contents[0]!.parts.find((p) => "inlineData" in p) as
      | { inlineData: { mimeType: string; data: string } }
      | undefined;
    expect(inline?.inlineData.mimeType).toBe("audio/mp3");
    expect(inline?.inlineData.data).toBe("QUJD");
  });

  test("anthropic drops unsupported audio part (keeps text)", () => {
    const c = parse(OPENAI_AUDIO_MSG as never);
    const out = toProvider("anthropic", c) as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const types = out.messages[0]!.content.map((b) => b.type);
    expect(types).toEqual(["text"]);
  });
});
