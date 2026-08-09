import type { RegistryEntry } from "~/types";

export const CUSTOM_ENTRY: RegistryEntry = {
  id: "custom",
  alias: "Custom",
  free: true,
  authType: "bearer",
  baseUrl: "",
  format: "openai",
  description: "Isi manual — URL & auth apa pun",
  color: "bg-gray-500",
  models: [],
};
