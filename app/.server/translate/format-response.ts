import type { ClientFormat, ProviderFormat } from "./canonical";

type Extracted = {
  text: string;
  reasoning: string;
  toolCalls: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  finishReason: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
  model: string;
  id: string;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function usageNum(u: Record<string, unknown>, key: string): number {
  return typeof u[key] === "number" ? (u[key] as number) : 0;
}

function extractOpenAi(json: Record<string, unknown>): Extracted {
  const choice = asRecord((json.choices as unknown[] | undefined)?.[0]);
  const message = asRecord(choice.message);
  const usage = asRecord(json.usage);
  const content = message.content;
  const text = typeof content === "string" ? content : "";
  const toolCalls: Extracted["toolCalls"] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const raw of message.tool_calls) {
      const tc = asRecord(raw);
      const fn = asRecord(tc.function);
      toolCalls.push({
        id: typeof tc.id === "string" ? tc.id : "",
        type: "function",
        function: {
          name: typeof fn.name === "string" ? fn.name : "",
          arguments: typeof fn.arguments === "string" ? fn.arguments : "",
        },
      });
    }
  }
  return {
    text,
    reasoning:
      typeof message.reasoning_content === "string"
        ? message.reasoning_content
        : typeof message.reasoning === "string"
          ? message.reasoning
          : "",
    toolCalls,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : "stop",
    usage:
      json.usage === undefined
        ? undefined
        : {
            prompt_tokens: usageNum(usage, "prompt_tokens"),
            completion_tokens: usageNum(usage, "completion_tokens"),
          },
    model: typeof json.model === "string" ? json.model : "",
    id: typeof json.id === "string" ? json.id : "",
  };
}

function extractAnthropic(json: Record<string, unknown>): Extracted {
  const usage = asRecord(json.usage);
  const toolCalls: Extracted["toolCalls"] = [];
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  if (Array.isArray(json.content)) {
    for (const raw of json.content) {
      const block = asRecord(raw);
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      }
      if (block.type === "thinking" && typeof block.thinking === "string") {
        thinkingParts.push(block.thinking);
      }
      if (block.type === "tool_use") {
        toolCalls.push({
          id: typeof block.id === "string" ? block.id : "",
          type: "function",
          function: {
            name: typeof block.name === "string" ? block.name : "",
            arguments: block.input !== undefined ? JSON.stringify(block.input) : "{}",
          },
        });
      }
    }
  }
  return {
    text: textParts.join(""),
    reasoning: thinkingParts.join(""),
    toolCalls,
    finishReason: typeof json.stop_reason === "string" ? json.stop_reason : "end_turn",
    usage:
      json.usage === undefined
        ? undefined
        : {
            prompt_tokens: usageNum(usage, "input_tokens"),
            completion_tokens: usageNum(usage, "output_tokens"),
          },
    model: typeof json.model === "string" ? json.model : "",
    id: typeof json.id === "string" ? json.id : "",
  };
}

function extractGemini(json: Record<string, unknown>): Extracted {
  const candidate = asRecord((json.candidates as unknown[] | undefined)?.[0]);
  const content = asRecord(candidate.content);
  const meta = asRecord(json.usageMetadata);
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: Extracted["toolCalls"] = [];
  if (Array.isArray(content.parts)) {
    for (const raw of content.parts) {
      const part = asRecord(raw);
      if (typeof part.text === "string") {
        if (part.thought === true) thinkingParts.push(part.text);
        else textParts.push(part.text);
      }
      const fc = asRecord(part.functionCall);
      if (Object.keys(fc).length > 0) {
        toolCalls.push({
          id: "",
          type: "function",
          function: {
            name: typeof fc.name === "string" ? fc.name : "",
            arguments: fc.args !== undefined ? JSON.stringify(fc.args) : "{}",
          },
        });
      }
    }
  }
  return {
    text: textParts.join(""),
    reasoning: thinkingParts.join(""),
    toolCalls,
    finishReason: typeof candidate.finishReason === "string" ? candidate.finishReason : "STOP",
    usage:
      json.usageMetadata === undefined
        ? undefined
        : {
            prompt_tokens: usageNum(meta, "promptTokenCount"),
            completion_tokens: usageNum(meta, "candidatesTokenCount"),
          },
    model: "",
    id: "",
  };
}

function stopReasonToAnthropic(reason: string): string {
  if (reason === "stop") return "end_turn";
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "length") return "max_tokens";
  return reason;
}

function buildChat(ext: Extracted): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: ext.text,
  };
  if (ext.reasoning !== "") message.reasoning_content = ext.reasoning;
  if (ext.toolCalls.length > 0) message.tool_calls = ext.toolCalls;
  return {
    id: ext.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: ext.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: ext.finishReason,
      },
    ],
    usage: ext.usage
      ? {
          prompt_tokens: ext.usage.prompt_tokens,
          completion_tokens: ext.usage.completion_tokens,
          total_tokens: ext.usage.prompt_tokens + ext.usage.completion_tokens,
        }
      : undefined,
  };
}

function buildAnthropic(ext: Extracted): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  // Omit signature (display only).
  if (ext.reasoning !== "") content.push({ type: "thinking", thinking: ext.reasoning });
  if (ext.text !== "") content.push({ type: "text", text: ext.text });
  for (const tc of ext.toolCalls) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.function.arguments);
    } catch {
      input = {};
    }
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.function.name,
      input,
    });
  }
  return {
    id: ext.id,
    type: "message",
    role: "assistant",
    model: ext.model,
    content,
    stop_reason: stopReasonToAnthropic(ext.finishReason),
    usage: ext.usage
      ? { input_tokens: ext.usage.prompt_tokens, output_tokens: ext.usage.completion_tokens }
      : undefined,
  };
}

function buildResponses(ext: Extracted): Record<string, unknown> {
  const output: Record<string, unknown>[] = [];
  if (ext.reasoning !== "") {
    output.push({
      id: `rs_${ext.id || Date.now().toString(16)}`,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: ext.reasoning }],
    });
  }
  if (ext.text !== "" || ext.toolCalls.length === 0) {
    output.push({
      id: `msg_${ext.id || Date.now().toString(16)}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: ext.text !== "" ? [{ type: "output_text", text: ext.text }] : [],
    });
  }
  for (const tc of ext.toolCalls) {
    output.push({
      id: `fc_${tc.id || Date.now().toString(16)}`,
      type: "function_call",
      status: "completed",
      name: tc.function.name,
      arguments: tc.function.arguments,
      call_id: tc.id,
    });
  }
  return {
    id: ext.id || `resp_${Date.now().toString(16)}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: ext.model,
    output,
    usage: ext.usage
      ? {
          input_tokens: ext.usage.prompt_tokens,
          output_tokens: ext.usage.completion_tokens,
          total_tokens: ext.usage.prompt_tokens + ext.usage.completion_tokens,
        }
      : undefined,
  };
}

export function translateResponse(
  providerFormat: ProviderFormat,
  clientFormat: ClientFormat,
  json: unknown,
): unknown {
  if (json === null || typeof json !== "object") return json;
  const record = json as Record<string, unknown>;
  if (providerFormat === "openai" && clientFormat === "openai-chat") return json;
  if (providerFormat === "anthropic" && clientFormat === "anthropic") return json;
  const extract =
    providerFormat === "anthropic"
      ? extractAnthropic
      : providerFormat === "gemini"
        ? extractGemini
        : extractOpenAi;
  const ext = extract(record);
  if (clientFormat === "openai-responses") return buildResponses(ext);
  if (clientFormat === "anthropic") return buildAnthropic(ext);
  return buildChat(ext);
}
