import type { CanonicalRequest, ProviderFormat } from "./canonical";
import { build as toOpenAi } from "./to-openai";
import { build as toAnthropic } from "./to-anthropic";
import { build as toGemini } from "./to-gemini";

export * from "./canonical";
export { parse as parseChat } from "./from-openai-chat";
export { parse as parseResponses } from "./from-responses";
export { parse as parseAnthropic } from "./from-anthropic";
export { parseFrame } from "./parse-stream";
export { formatEvent, composeStreamTransformer } from "./format-stream";
export { translateResponse } from "./format-response";

export function toProvider(
  format: ProviderFormat,
  c: CanonicalRequest,
): Record<string, unknown> {
  switch (format) {
    case "anthropic":
      return toAnthropic(c);
    case "gemini":
      return toGemini(c);
    default:
      return toOpenAi(c);
  }
}
