import type {
  CanonicalContentPart,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalTool,
} from "./canonical";

const MAPPED_KEYS = new Set([
  "model",
  "input",
  "instructions",
  "stream",
  "temperature",
  "top_p",
  "max_output_tokens",
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

function mapRole(role: unknown): CanonicalMessage["role"] {
  if (role === "system" || role === "developer") return "system";
  if (role === "assistant") return "assistant";
  if (role === "tool") return "tool";
  return "user";
}

function parsePart(part: unknown): CanonicalContentPart | null {
  if (!part || typeof part !== "object") return null;
  const p = part as Record<string, unknown>;
  if (p.type === "input_text" || p.type === "output_text") {
    if (typeof p.text === "string") return { type: "text", text: p.text };
    return null;
  }
  if (p.type === "input_image") {
    if (typeof p.image_url === "string") {
      return { type: "image", image_url: p.image_url };
    }
    if (typeof p.data === "string") {
      return {
        type: "image",
        data: p.data,
        media_type: typeof p.media_type === "string" ? p.media_type : undefined,
      };
    }
    return null;
  }
  return null;
}

function parseContent(content: unknown): string | CanonicalContentPart[] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map(parsePart)
      .filter((p): p is CanonicalContentPart => p !== null);
    return parts.length > 0 ? parts : "";
  }
  return "";
}

function parseItem(item: unknown): CanonicalMessage[] {
  if (!item || typeof item !== "object") return [];
  const it = item as Record<string, unknown>;
  const role = mapRole(it.role);
  const messages: CanonicalMessage[] = [];
  const parts = Array.isArray(it.content) ? it.content : [];
  const toolCalls: NonNullable<CanonicalMessage["tool_calls"]> = [];
  const toolParts: CanonicalContentPart[] = [];

  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "function_call") {
      toolCalls.push({
        id: typeof p.call_id === "string" ? p.call_id : "",
        type: "function",
        function: {
          name: typeof p.name === "string" ? p.name : "",
          arguments: typeof p.arguments === "string" ? p.arguments : "",
        },
      });
      continue;
    }
    if (p.type === "function_call_output") {
      const output = typeof p.output === "string" ? p.output : "";
      messages.push({
        role: "tool",
        content: output,
        tool_call_id: typeof p.call_id === "string" ? p.call_id : "",
      });
      continue;
    }
    const part2 = parsePart(p);
    if (part2) toolParts.push(part2);
  }

  const base = {
    role,
    content: parseContent(it.content),
  };
  if (role === "assistant" && toolCalls.length > 0) {
    messages.push({ ...base, content: base.content === "" ? "" : base.content, tool_calls: toolCalls });
  } else if (toolParts.length > 0) {
    messages.push({ ...base, content: toolParts });
  } else {
    messages.push(base);
  }
  return messages;
}

function parseInput(input: unknown): CanonicalMessage[] {
  if (typeof input === "string" && input.trim() !== "") {
    return [{ role: "user", content: input }];
  }
  if (!Array.isArray(input)) return [];
  const out: CanonicalMessage[] = [];
  for (const item of input) {
    out.push(...parseItem(item));
  }
  return out;
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
          t.parameters && typeof t.parameters === "object"
            ? (t.parameters as Record<string, unknown>)
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
  const messages = parseInput(body.input);
  const instructions = body.instructions;
  if (typeof instructions === "string" && instructions.trim() !== "") {
    messages.unshift({ role: "system", content: instructions });
  }
  const tools = parseTools(body.tools);
  let toolChoice = body.tool_choice;
  if (toolChoice && typeof toolChoice === "object") {
    const tc = toolChoice as Record<string, unknown>;
    if (tc.type === "function" && typeof tc.name === "string") {
      toolChoice = { type: "function", function: { name: tc.name } };
    }
  }
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
    max_tokens: asNumber(body.max_output_tokens),
    stop: typeof body.stop === "string" ? body.stop : Array.isArray(body.stop) ? (body.stop as string[]) : undefined,
    tools,
    tool_choice: toolChoice,
    extra,
  };
}
