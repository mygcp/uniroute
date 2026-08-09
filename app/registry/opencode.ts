import type { RegistryEntry } from "~/types";

export const OPENCODE_ENTRY: RegistryEntry = {
  id: "opencode",
  alias: "OpenCode Zen",
  format: "openai",
  authType: "none",
  baseUrl: "https://opencode.ai/zen/v1",
  modelsUrl: "https://opencode.ai/zen/v1/models",
  urlSuffix: "chat/completions",
  passthroughModels: true,
  defaultContextLength: 200000,
  free: true,
  description: "OpenCode ZEN gateway (OpenAI-compatible, no API key)",
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
    { id: "ling-3.0-flash-free", name: "Ling 3.0 Flash Free" },
    { id: "ling-3.0-tiny-free", name: "Ling 3.0 Tiny Free" },
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
    { id: "laguna-s-2.1-free", name: "Laguna S 2.1 Free" },
    { id: "longcat-2.0-free", name: "Longcat 2.0 Free" },
  ],
};