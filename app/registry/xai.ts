import type { RegistryEntry } from "~/types";

export const XAI_ENTRY: RegistryEntry = {
  id: "xai",
  alias: "xAI (Grok)",
  free: false,
  authType: "bearer",
  baseUrl: "https://api.x.ai",
  format: "openai",
  description: "Grok models, OpenAI-compatible",
  color: "bg-slate-800",
  modelsUrl: "https://api.x.ai/v1/models",
  models: [
    { id: "grok-2", name: "Grok 2", contextLength: 131072 },
    { id: "grok-2-mini", name: "Grok 2 Mini", contextLength: 131072 },
    { id: "grok-beta", name: "Grok Beta", contextLength: 131072 },
  ],
};
