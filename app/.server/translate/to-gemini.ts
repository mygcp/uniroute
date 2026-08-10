import type { CanonicalMessage, CanonicalRequest } from "./canonical";

function toParts(
  message: CanonicalMessage,
  toolNameById: Map<string, string>,
): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  if (message.role === "tool") {
    const name = message.name ?? toolNameById.get(message.tool_call_id ?? "") ?? "tool";
    parts.push({
      functionResponse: {
        name,
        response: {
          result: typeof message.content === "string" ? message.content : "",
        },
      },
    });
    return parts;
  }
  if (typeof message.content === "string" && message.content !== "") {
    parts.push({ text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const p of message.content) {
      if (p.type === "text") {
        parts.push({ text: p.text });
      } else if (p.type === "image") {
        if (p.image_url) {
          parts.push({
            fileData: {
              fileUri: p.image_url,
              ...(p.media_type ? { mimeType: p.media_type } : {}),
            },
          });
        } else if (p.data) {
          parts.push({
            inlineData: {
              mimeType: p.media_type ?? "image/png",
              data: p.data,
            },
          });
        }
      }
    }
  }
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      toolNameById.set(tc.id, tc.function.name);
      let args: unknown = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }
      parts.push({ functionCall: { name: tc.function.name, args } });
    }
  }
  return parts;
}

export function build(c: CanonicalRequest): Record<string, unknown> {
  const system = c.messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter((s) => s !== "")
    .join("\n\n");

  const toolNameById = new Map<string, string>();
  const contents = c.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: toParts(m, toolNameById),
    }));

  const body: Record<string, unknown> = {
    contents,
    ...(c.stream !== undefined ? { stream: c.stream } : {}),
  };
  if (system !== "") body.systemInstruction = { parts: [{ text: system }] };
  if (c.tools !== undefined && c.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: c.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      },
    ];
  }
  const gc: Record<string, unknown> = {};
  if (c.temperature !== undefined) gc.temperature = c.temperature;
  if (c.top_p !== undefined) gc.topP = c.top_p;
  if (c.max_tokens !== undefined) gc.maxOutputTokens = c.max_tokens;
  if (c.stop !== undefined) {
    gc.stopSequences = Array.isArray(c.stop) ? c.stop : [c.stop];
  }
  if (Object.keys(gc).length > 0) body.generationConfig = gc;
  return { ...body, ...c.extra };
}
