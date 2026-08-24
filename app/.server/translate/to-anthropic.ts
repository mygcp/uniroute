import type { CanonicalMessage, CanonicalRequest } from "./canonical";

function toBlock(part: {
  type: string;
  text?: string;
  image_url?: string;
  data?: string;
  media_type?: string;
  format?: string;
}): Record<string, unknown> | null {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "image") {
    if (part.image_url) {
      return { type: "image", source: { type: "url", url: part.image_url } };
    }
    if (part.data) {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: part.media_type ?? "image/png",
          data: part.data,
        },
      };
    }
  }
  // Anthropic messages API tidak mendukung audio → bagian diabaikan.
  if (part.type === "audio") return null;
  return { type: "text", text: "" };
}

function contentBlocks(message: CanonicalMessage): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  if (typeof message.content === "string" && message.content !== "") {
    blocks.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const p of message.content) {
      const block = toBlock(p);
      if (block) blocks.push(block);
    }
  }
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = {};
      }
      blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
  }
  return blocks;
}

function toAnthropicMessages(messages: CanonicalMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let pendingToolResults: Record<string, unknown>[] = [];
  const flushTools = (): void => {
    if (pendingToolResults.length > 0) {
      out.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  };
  for (const message of messages) {
    if (message.role === "tool") {
      const name =
        typeof message.name === "string"
          ? message.name
          : `tool_${message.tool_call_id ?? ""}`;
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: message.tool_call_id ?? "",
        name,
        content: typeof message.content === "string" ? message.content : "",
      });
      continue;
    }
    flushTools();
    const role = message.role === "assistant" ? "assistant" : "user";
    out.push({ role, content: contentBlocks(message) });
  }
  flushTools();
  return out;
}

function mapToolChoice(tc: unknown): Record<string, unknown> | undefined {
  if (typeof tc === "string") {
    if (tc === "none") return { type: "none" };
    if (tc === "any" || tc === "required") return { type: "any" };
    return { type: "auto" };
  }
  if (tc && typeof tc === "object") {
    const t = tc as Record<string, unknown>;
    if (t.type === "function") {
      const fn = (t.function ?? {}) as Record<string, unknown>;
      if (typeof fn.name === "string") return { type: "tool", name: fn.name };
    }
    if (typeof t.name === "string") return { type: "tool", name: t.name };
    if (t.type === "tool") return { type: "tool", name: typeof t.name === "string" ? t.name : undefined };
    if (t.type === "none") return { type: "none" };
    if (t.type === "any") return { type: "any" };
    return { type: "auto" };
  }
  return undefined;
}

export function build(c: CanonicalRequest): Record<string, unknown> {
  const system = c.messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter((s) => s !== "")
    .join("\n\n");
  const messages = toAnthropicMessages(c.messages.filter((m) => m.role !== "system"));

  const body: Record<string, unknown> = {
    model: c.model,
    messages,
    max_tokens: c.max_tokens ?? 4096,
  };
  if (system !== "") body.system = system;
  if (c.temperature !== undefined) body.temperature = c.temperature;
  if (c.top_p !== undefined) body.top_p = c.top_p;
  body.stream = c.stream;
  if (c.stop !== undefined) {
    body.stop_sequences = Array.isArray(c.stop) ? c.stop : [c.stop];
  }
  if (c.tools !== undefined && c.tools.length > 0) {
    body.tools = c.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }
  const toolChoice = mapToolChoice(c.tool_choice);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  return { ...body, ...c.extra };
}
