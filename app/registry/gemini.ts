import type { RegistryEntry } from "~/types";

export const GEMINI_ENTRY: RegistryEntry = {
  id: "gemini",
  alias: "Google Gemini",
  free: false,
  authType: "apikey",
  baseUrl: "https://generativelanguage.googleapis.com",
  format: "gemini",
  description: "Gemini via OpenAI-compat endpoint (x-goog-api-key)",
  color: "bg-blue-500",
  modelsUrl: "https://generativelanguage.googleapis.com/v1beta/models",
  models: [
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", contextLength: 1048576 },
    { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", contextLength: 2097152 },
    { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", contextLength: 1048576 },
  ],
};
