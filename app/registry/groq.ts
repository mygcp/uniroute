import type { RegistryEntry } from "~/types";

export const GROQ_ENTRY: RegistryEntry = {
  id: "groq",
  alias: "Groq",
  free: false,
  authType: "bearer",
  baseUrl: "https://api.groq.com",
  format: "openai",
  description: "LPU inference, models llama & mixtral",
  color: "bg-purple-500",
  modelsUrl: "https://api.groq.com/openai/v1/models",
  models: [
    { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B Instant", contextLength: 131072 },
    { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B Versatile", contextLength: 131072 },
    { id: "llama-3.1-70b-versatile", name: "Llama 3.1 70B Versatile", contextLength: 131072 },
    { id: "mixtral-8x7b-32768", name: "Mixtral 8x7B", contextLength: 32768 },
  ],
};
