import type { RegistryEntry } from "~/types";

export const LMSTUDIO_ENTRY: RegistryEntry = {
  id: "lmstudio",
  alias: "LM Studio (local)",
  free: true,
  authType: "none",
  baseUrl: "http://localhost:1234",
  format: "openai",
  description: "Local server with OpenAI-compatible API",
  color: "bg-sky-600",
  modelsUrl: "http://localhost:1234/v1/models",
  models: [],
};
