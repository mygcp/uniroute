import type { RegistryEntry } from "~/types";

export const DAHL_ENTRY: RegistryEntry = {
  id: "dahl",
  alias: "Dahl Global",
  free: false,
  authType: "bearer",
  baseUrl: "https://inference.dahl.global/v1",
  urlSuffix: "chat/completions",
  format: "openai",
  description: "Dahl Global inference, OpenAI-compatible",
  color: "bg-purple-600",
  modelsUrl: "https://inference.dahl.global/v1/models",
  models: [
    { id: "MiniMaxAI/MiniMax-M2.7", name: "MiniMax M2.7", contextLength: 200000 },
    { id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6", contextLength: 200000 },
  ],
};