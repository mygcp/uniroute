import type {
  CanonicalContentPart,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalTool,
} from "./canonical";

const MAPPED_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "temperature",
  "top_p",
  "max_tokens",
  "stop",
  "tools",
  "tool_choice",
]);

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function parseStop(v: unknown): string | string[] | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.every((s) => typeof s === "string")) return v as string[];
  return undefined;
}

function parseContentPart(part: unknown): CanonicalContentPart | null {
  if (!part || typeof part !== "object") return null;
  const p = part as Record<string, unknown>;
  if (p.type === "text" && typeof p.text === "string") {
    return { type: "text", text: p.text };
  }
  if (p.type === "image_url") {
    const img = p.image_url as Record<string, unknown> | string | undefined;
    const url = typeof img === "string" ? img : (img as Record<string, unknown> | undefined)?.url;
    if (typeof url === "string") return { type: "image", image_url: url };
  }
  if (p.type === "input_audio") {
    const ia = p.input_audio as Record<string, unknown> | undefined;
    const data = typeof ia?.data === "string" ? ia.data : "";
    if (data) {
      return {
        type: "audio",
        data,
        format: typeof ia?.format === "string" ? ia.format : undefined,
      };
    }
  }
  return null;
}

function parseContent(content: unknown): string | CanonicalContentPart[] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map(parseContentPart)
      .filter((p): p is CanonicalContentPart => p !== null);
    return parts.length > 0 ? parts : "";
  }
  return "";
}

function parseToolCall(tc: unknown): CanonicalMessage["tool_calls"] {
  if (!tc || typeof tc !== "object") return undefined;
  const t = tc as Record<string, unknown>;
  const fn = (t.function ?? {}) as Record<string, unknown>;
  return [
    {
      id: typeof t.id === "string" ? t.id : "",
      type: "function",
      function: {
        name: typeof fn.name === "string" ? fn.name : "",
        arguments: typeof fn.arguments === "string" ? fn.arguments : "",
      },
    },
  ];
}

function parseMessage(raw: unknown): CanonicalMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const role = m.role;
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
    return null;
  }
  const message: CanonicalMessage = {
    role,
    content: parseContent(m.content),
  };
  if (typeof m.name === "string") message.name = m.name;
  if (typeof m.tool_call_id === "string") message.tool_call_id = m.tool_call_id;
  if (Array.isArray(m.tool_calls)) {
    const calls = m.tool_calls
      .flatMap(parseToolCall)
      .filter((c): c is NonNullable<CanonicalMessage["tool_calls"]>[number] => c !== undefined);
    if (calls.length > 0) message.tool_calls = calls;
  }
  return message;
}

function parseTools(tools: unknown): CanonicalTool[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: CanonicalTool[] = [];
  for (const raw of tools) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown>;
    const fn = (t.function ?? {}) as Record<string, unknown>;
    if (typeof fn.name !== "string" || !fn.name) continue;
    out.push({
      type: "function",
      function: {
        name: fn.name,
        description: asString(fn.description),
        parameters:
          fn.parameters && typeof fn.parameters === "object"
            ? (fn.parameters as Record<string, unknown>)
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
  const messages = Array.isArray(body.messages)
    ? body.messages.map(parseMessage).filter((m): m is CanonicalMessage => m !== null)
    : [];
  const tools = parseTools(body.tools);
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
    stop: parseStop(body.stop),
    tools,
    tool_choice: body.tool_choice,
    extra,
  };
}
