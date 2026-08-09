import type { RegistryEntry } from "~/types";

export const CLOUDFLARE_ENTRY: RegistryEntry = {
  id: "cloudflare",
  alias: "Cloudflare",
  free: true,
  authType: "bearer",
  baseUrl: "https://api.cloudflare.com/client/v4",
  format: "openai",
  description: "Workers AI + AI Gateway (OpenAI compat)",
  color: "bg-orange-400",
  modelsUrl: "https://api.cloudflare.com/client/v4/accounts/me/ai/models/search",
  models: [
    {
      id: "@cf/meta/llama-3.1-8b-instruct",
      name: "Llama 3.1 8B Instruct",
      contextLength: 131072,
    },
    {
      id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      name: "Llama 3.3 70B Instruct",
      contextLength: 131072,
    },
    {
      id: "@cf/qwen/qwen1.5-14b-chat-awq",
      name: "Qwen 1.5 14B Chat",
      contextLength: 32768,
    },
    {
      id: "@cf/mistral/mistral-7b-instruct-v0.3",
      name: "Mistral 7B Instruct",
      contextLength: 32768,
    },
  ],
};
