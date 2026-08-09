import type { RegistryEntry } from "~/types";

export const DEEPSEEK_ENTRY: RegistryEntry = {
  id: "deepseek",
  alias: "DeepSeek",
  free: false,
  authType: "bearer",
  baseUrl: "https://api.deepseek.com",
  format: "openai",
  description: "DeepSeek V3 / R1, OpenAI-compatible",
  color: "bg-cyan-600",
  modelsUrl: "https://api.deepseek.com/v1/models",
  models: [
    { id: "deepseek-chat", name: "DeepSeek Chat (V3)", contextLength: 128000 },
    { id: "deepseek-reasoner", name: "DeepSeek Reasoner (R1)", contextLength: 128000 },
  ],
};
