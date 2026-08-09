import type { RegistryEntry } from "~/types";

export const NVIDIA_NIM_ENTRY: RegistryEntry = {
  id: "nvidia-nim",
  alias: "NVIDIA NIM",
  free: false,
  authType: "apikey",
  baseUrl: "https://integrate.api.nvidia.com",
  format: "openai",
  description: "Self-hosted / hosted NIM inference",
  color: "bg-lime-600",
  modelsUrl: "https://integrate.api.nvidia.com/v1/models",
  models: [
    {
      id: "nvidia/llama-3.1-8b-instruct",
      name: "Llama 3.1 8B Instruct",
      contextLength: 128000,
    },
    {
      id: "nvidia/llama-3.1-70b-instruct",
      name: "Llama 3.1 70B Instruct",
      contextLength: 128000,
    },
    {
      id: "nvidia/nemotron-4-340b-instruct",
      name: "Nemotron 4 340B Instruct",
      contextLength: 8192,
    },
    {
      id: "nvidia/gpt-oss-120b",
      name: "GPT-OSS 120B",
      contextLength: 8192,
    },
    {
      id: "meta/llama-3.1-8b-instruct",
      name: "Llama 3.1 8B (meta)",
      contextLength: 128000,
    },
    {
      id: "nvidia/nv-embedqa-e5-v5",
      name: "NV-EmbedQA E5 v5",
      contextLength: 8192,
      defaultParams: { input_type: "query" },
    },
  ],
};
