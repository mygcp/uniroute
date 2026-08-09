import type { RegistryEntry } from "~/types";

export const OPENAI_ENTRY: RegistryEntry = {
  id: "openai",
  alias: "OpenAI",
  free: false,
  authType: "bearer",
  baseUrl: "https://api.openai.com",
  format: "openai",
  description: "GPT & o-series, OpenAI-compatible",
  color: "bg-emerald-500",
  modelsUrl: "https://api.openai.com/v1/models",
  models: [
    { id: "gpt-4o", name: "GPT-4o", contextLength: 128000 },
    { id: "gpt-4o-mini", name: "GPT-4o Mini", contextLength: 128000 },
    { id: "gpt-4.1", name: "GPT-4.1", contextLength: 1048576 },
    { id: "o3-mini", name: "o3 Mini", contextLength: 200000 },
    { id: "gpt-4-turbo", name: "GPT-4 Turbo", contextLength: 128000 },
  ],
};
