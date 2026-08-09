export type RegistryAuthType = "none" | "apikey" | "bearer" | "oauth";
export type RegistryFormat = "openai" | "anthropic" | "gemini" | "claude";

export type RegistryModel = {
  id: string;
  name: string;
  contextLength?: number;
  supportsReasoning?: boolean;
  interleavedField?: string;
  defaultParams?: Record<string, unknown>;
};

export type RegistryEntry = {
  id: string;
  alias: string;
  free: boolean;
  authType: RegistryAuthType;
  baseUrl: string;
  format: RegistryFormat;
  models: RegistryModel[];
  executor?: string;
  authHeader?: string;
  authPrefix?: string;
  passthroughModels?: boolean;
  defaultContextLength?: number;
  headers?: Record<string, string>;
  urlSuffix?: string;
  modelsUrl?: string;
  description?: string;
  color?: string;
};

export interface ProviderCredential {
  providerId: string;
  apiKey: string | null;
  baseUrl: string | null;
  isFree: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
}
