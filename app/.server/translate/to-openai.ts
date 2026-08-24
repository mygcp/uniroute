import type { CanonicalMessage, CanonicalRequest } from "./canonical";

function toContentPart(part: CanonicalMessage["content"]): unknown {
  if (typeof part === "string") return part;
  return part.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "image") {
      if (p.image_url) {
        return { type: "image_url", image_url: { url: p.image_url } };
      }
      if (p.data) {
        const media = p.media_type ?? "image/png";
        return {
          type: "image_url",
          image_url: { url: `data:${media};base64,${p.data}` },
        };
      }
    }
    if (p.type === "audio") {
      return {
        type: "input_audio",
        input_audio: { data: p.data, format: p.format ?? "wav" },
      };
    }
    return null;
  }).filter(Boolean);
}

function toMessage(message: CanonicalMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: message.role,
    content: toContentPart(message.content),
  };
  if (message.name !== undefined) out.name = message.name;
  if (message.tool_call_id !== undefined) out.tool_call_id = message.tool_call_id;
  if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
    out.tool_calls = message.tool_calls;
  }
  return out;
}

export function build(c: CanonicalRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: c.model,
    messages: c.messages.map(toMessage),
    stream: c.stream,
  };
  if (c.temperature !== undefined) body.temperature = c.temperature;
  if (c.top_p !== undefined) body.top_p = c.top_p;
  if (c.max_tokens !== undefined) body.max_tokens = c.max_tokens;
  if (c.stop !== undefined) body.stop = c.stop;
  if (c.tools !== undefined && c.tools.length > 0) body.tools = c.tools;
  if (c.tool_choice !== undefined) body.tool_choice = c.tool_choice;
  return { ...body, ...c.extra };
}
