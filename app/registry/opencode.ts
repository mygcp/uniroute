import type { RegistryEntry } from "~/types";

export const OPENCODE_ENTRY: RegistryEntry = {
  id: "opencode",
  alias: "oc",
  format: "openai",
  executor: "opencode",
  authType: "apikey",
  baseUrl: "https://opencode.ai/zen/v1",
  modelsUrl: "https://opencode.ai/zen/v1/models",
  authHeader: "Authorization",
  authPrefix: "Bearer",
  passthroughModels: true,
  defaultContextLength: 200000,
  free: true,
  description: "OpenCode ZEN gateway (OpenAI-compatible)",
  color: "bg-slate-500",
  models: [
    {
      id: "big-pickle",
      name: "Big Pickle",
      supportsReasoning: true,
      interleavedField: "reasoning_content",
    },
    {
      id: "deepseek-v4-flash-free",
      name: "DeepSeek V4 Flash Free",
      supportsReasoning: true,
    },
    { id: "mimo-v2.5-free", name: "MiMo V2.5 Free", contextLength: 131000 },
    { id: "hy3-free", name: "HY3 Free", contextLength: 131000 },
    {
      id: "nemotron-3-ultra-free",
      name: "Nemotron 3 Ultra Free",
      contextLength: 1000000,
    },
    {
      id: "north-mini-code-free",
      name: "North Mini Code Free",
      contextLength: 131000,
    },
  ],
};