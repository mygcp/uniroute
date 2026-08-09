import type { RegistryEntry } from "~/types";

export const OLLAMA_ENTRY: RegistryEntry = {
  id: "ollama",
  alias: "Ollama (local)",
  free: true,
  authType: "none",
  baseUrl: "http://localhost:11434",
  format: "openai",
  description: "Local models via Ollama, no auth",
  color: "bg-teal-600",
  modelsUrl: "http://localhost:11434/v1/models",
  models: [
    { id: "llama3.1", name: "Llama 3.1", contextLength: 131072 },
    { id: "qwen2.5", name: "Qwen 2.5", contextLength: 131072 },
    { id: "mistral", name: "Mistral", contextLength: 32768 },
    { id: "llava", name: "LLaVA (vision)", contextLength: 4096 },
  ],
};
