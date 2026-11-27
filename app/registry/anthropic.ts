import type { RegistryEntry } from "~/types";

export const ANTHROPIC_ENTRY: RegistryEntry = {
  id: "anthropic",
  alias: "Anthropic",
  free: false,
  authType: "bearer",
  baseUrl: "https://api.anthropic.com",
  format: "anthropic",
  description: "Claude, Anthropic-compatible gateway",
  color: "bg-orange-500",
  modelsUrl: "https://api.anthropic.com/v1/models",
  models: [
    { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", contextLength: 200000 },
    { id: "claude-3-opus", name: "Claude 3 Opus", contextLength: 200000 },
    { id: "claude-3-5-haiku", name: "Claude 3.5 Haiku", contextLength: 200000 },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4", contextLength: 200000 },
  ],
};
