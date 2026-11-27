import type { RegistryEntry } from "~/types";

export const CUSTOM_ENTRY: RegistryEntry = {
  id: "custom",
  alias: "Custom",
  free: true,
  authType: "bearer",
  baseUrl: "",
  format: "openai",
  description: "Manual setup: any URL and auth type",
  color: "bg-gray-500",
  models: [],
};
