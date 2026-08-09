import type { RegistryEntry } from "~/types";

export const MISTRAL_ENTRY: RegistryEntry = {
  id: "mistral",
  alias: "Mistral",
  free: false,
  authType: "bearer",
  baseUrl: "https://api.mistral.ai",
  format: "openai",
  description: "Mistral & Codestral, OpenAI-compatible",
  color: "bg-indigo-500",
  modelsUrl: "https://api.mistral.ai/v1/models",
  models: [
    { id: "mistral-large", name: "Mistral Large", contextLength: 128000 },
    { id: "mistral-small", name: "Mistral Small", contextLength: 32768 },
    { id: "codestral", name: "Codestral", contextLength: 32768 },
    { id: "open-mistral-7b", name: "Open Mistral 7B", contextLength: 32768 },
  ],
};
