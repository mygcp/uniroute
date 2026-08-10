import type {
  CanonicalContentPart,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalTool,
} from "./canonical";

const MAPPED_KEYS = new Set([
  "model",
  "system",
  "messages",
  "stream",
  "temperature",
  "top_p",
  "max_tokens",
  "stop_sequences",
  "tools",
  "tool_choice",
]);

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function parseBlock(block: unknown): CanonicalContentPart | "tool_use" | "tool_result" | null {
  if (!block || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  if (b.type === "text" && typeof b.text === "string") {
    return { type: "text", text: b.text };
  }
  if (b.type === "image") {
    const src = b.source as Record<string, unknown> | undefined;
    if (src?.type === "url" && typeof src.url === "string") {
      return { type: "image", image_url: src.url };
    }
    if (src?.type === "base64" && typeof src.data === "string") {
      return {
        type: "image",
        data: src.data,
        media_type: typeof src.media_type === "string" ? src.media_type : undefined,
      };
    }
    return null;
  }
  if (b.type === "tool_use") return "tool_use";
  if (b.type === "tool_result") return "tool_result";
  return null;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (!c || typeof c !== "object") return "";
        const t = c as Record<string, unknown>;
        return t.type === "text" && typeof t.text === "string" ? t.text : "";
      })
      .join("");
  }
  return "";
}

function parseMessage(raw: unknown): CanonicalMessage[] {
  if (!raw || typeof raw !== "object") return [];
  const m = raw as Record<string, unknown>;
  const role = m.role;
  if (role !== "user" && role !== "assistant") return [];
  const content = Array.isArray(m.content) ? m.content : [];
  const toolCalls: NonNullable<CanonicalMessage["tool_calls"]> = [];
  const toolResults: { callId: string; output: string }[] = [];
  const parts: CanonicalContentPart[] = [];

  for (const block of content) {
    const parsed = parseBlock(block);
    if (parsed === null) continue;
    if (parsed === "tool_use") {
      const b = block as Record<string, unknown>;
      toolCalls.push({
        id: typeof b.id === "string" ? b.id : "",
        type: "function",
        function: {
          name: typeof b.name === "string" ? b.name : "",
          arguments: b.input !== undefined ? JSON.stringify(b.input) : "",
        },
      });
      continue;
    }
    if (parsed === "tool_result") {
      const b = block as Record<string, unknown>;
      if (typeof b.tool_use_id === "string") {
        toolResults.push({ callId: b.tool_use_id, output: blockText(b.content) });
      }
      continue;
    }
    parts.push(parsed);
  }

  const messages: CanonicalMessage[] = [];
  if (toolResults.length > 0) {
    for (const tr of toolResults) {
      messages.push({ role: "tool", content: tr.output, tool_call_id: tr.callId });
    }
  }
  const contentValue = parts.length > 0 ? parts : typeof m.content === "string" ? m.content : "";
  const base: CanonicalMessage = { role, content: contentValue };
  if (role === "assistant" && toolCalls.length > 0) {
    base.tool_calls = toolCalls;
  }
  messages.push(base);
  return messages;
}

function parseTools(tools: unknown): CanonicalTool[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: CanonicalTool[] = [];
  for (const raw of tools) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown>;
    if (typeof t.name !== "string" || !t.name) continue;
    out.push({
      type: "function",
      function: {
        name: t.name,
        description: asString(t.description),
        parameters:
          t.input_schema && typeof t.input_schema === "object"
            ? (t.input_schema as Record<string, unknown>)
            : { type: "object", properties: {} },
      },
    });
  }
  return out.length > 0 ? out : undefined;
}

export function parse(body: Record<string, unknown>): CanonicalRequest {
  const model = body.model;
  if (typeof model !== "string" || model.trim() === "") {
    throw new Error("model required");
  }
  const messages: CanonicalMessage[] = [];
  const systemRaw = body.system;
  if (typeof systemRaw === "string" && systemRaw.trim() !== "") {
    messages.push({ role: "system", content: systemRaw });
  } else if (Array.isArray(systemRaw)) {
    const systemText = blockText(systemRaw);
    if (systemText !== "") messages.push({ role: "system", content: systemText });
  }
  if (Array.isArray(body.messages)) {
    for (const raw of body.messages) {
      messages.push(...parseMessage(raw));
    }
  }
  const tools = parseTools(body.tools);
  const stop = Array.isArray(body.stop_sequences)
    ? (body.stop_sequences.filter((s) => typeof s === "string") as string[])
    : undefined;
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!MAPPED_KEYS.has(k)) extra[k] = v;
  }
  return {
    model,
    messages,
    stream: body.stream === true,
    temperature: asNumber(body.temperature),
    top_p: asNumber(body.top_p),
    max_tokens: asNumber(body.max_tokens),
    stop,
    tools,
    tool_choice: body.tool_choice,
    extra,
  };
}
