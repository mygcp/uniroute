import type { RegistryEntry } from "~/types";
import { ANTHROPIC_ENTRY } from "./anthropic";
import { CLOUDFLARE_ENTRY } from "./cloudflare";
import { CUSTOM_ENTRY } from "./custom";
import { DEEPSEEK_ENTRY } from "./deepseek";
import { GEMINI_ENTRY } from "./gemini";
import { GROQ_ENTRY } from "./groq";
import { LMSTUDIO_ENTRY } from "./lmstudio";
import { MISTRAL_ENTRY } from "./mistral";
import { NVIDIA_NIM_ENTRY } from "./nvidia-nim";
import { OLLAMA_ENTRY } from "./ollama";
import { OPENAI_ENTRY } from "./openai";
import { OPENCODE_ENTRY } from "./opencode";
import { XAI_ENTRY } from "./xai";

export const PROVIDER_REGISTRY: RegistryEntry[] = [
  OPENAI_ENTRY,
  ANTHROPIC_ENTRY,
  NVIDIA_NIM_ENTRY,
  CLOUDFLARE_ENTRY,
  GROQ_ENTRY,
  MISTRAL_ENTRY,
  XAI_ENTRY,
  GEMINI_ENTRY,
  DEEPSEEK_ENTRY,
  OLLAMA_ENTRY,
  LMSTUDIO_ENTRY,
  OPENCODE_ENTRY,
  CUSTOM_ENTRY,
];

export function getRegistryEntry(id: string): RegistryEntry | undefined {
  return PROVIDER_REGISTRY.find((e) => e.id === id);
}
