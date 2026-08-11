import { query } from "./db";

export type ModelPrice = {
  input: number;
  output: number;
};

export type PricingOverride = {
  model: string;
  provider_id: string;
  input_per_mtok: number;
  output_per_mtok: number;
};

/**
 * Harga bawaan per 1M token (USD) untuk model populer. Nilai mendekati harga
 * publik; admin dapat menimpa via tabel `model_pricing`.
 */
export const STATIC_PRICES: Record<string, ModelPrice> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-haiku-4": { input: 1, output: 5 },
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
  "mistral-large": { input: 3, output: 9 },
  "mistral-medium": { input: 2.7, output: 8.1 },
  "llama-3.1-8b": { input: 0.05, output: 0.08 },
  "llama-3.1-70b": { input: 0.35, output: 0.4 },
  "llama-3.1-405b": { input: 2.75, output: 2.75 },
  "grok-2": { input: 2, output: 10 },
};

/** Prioritas: override DB (`model_pricing`) > `STATIC_PRICES` > 0. */
export function getPrice(model: string, providerId?: string | null): ModelPrice {
  const key = `${model.trim().toLowerCase()}::${(providerId ?? "").trim().toLowerCase()}`;
  const exact = query(
    "SELECT input_per_mtok, output_per_mtok FROM model_pricing WHERE model = ? AND provider_id = ?",
  ).get(model.trim().toLowerCase(), (providerId ?? "").trim().toLowerCase()) as
    | { input_per_mtok: number; output_per_mtok: number }
    | undefined;
  if (exact) {
    return { input: exact.input_per_mtok, output: exact.output_per_mtok };
  }
  const byModel = query(
    "SELECT input_per_mtok, output_per_mtok FROM model_pricing WHERE model = ?",
  ).get(model.trim().toLowerCase()) as
    | { input_per_mtok: number; output_per_mtok: number }
    | undefined;
  if (byModel) {
    return { input: byModel.input_per_mtok, output: byModel.output_per_mtok };
  }
  const lower = STATIC_PRICES[model.trim().toLowerCase()];
  if (lower) return lower;
  return STATIC_PRICES[model.trim()] ?? { input: 0, output: 0 };
}

export function setPrice(
  model: string,
  providerId: string,
  inputPerMtok: number,
  outputPerMtok: number,
): void {
  query(
    `INSERT INTO model_pricing (model, provider_id, input_per_mtok, output_per_mtok)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(model, provider_id) DO UPDATE SET
       input_per_mtok = excluded.input_per_mtok,
       output_per_mtok = excluded.output_per_mtok,
       updated_at = unixepoch()`,
  ).run(
    model.trim().toLowerCase(),
    providerId.trim().toLowerCase(),
    inputPerMtok,
    outputPerMtok,
  );
}

export function listOverrides(): PricingOverride[] {
  return query(
    "SELECT model, provider_id, input_per_mtok, output_per_mtok FROM model_pricing ORDER BY model ASC",
  ).all() as unknown as PricingOverride[];
}

export function deleteOverride(model: string, providerId: string): void {
  query(
    "DELETE FROM model_pricing WHERE model = ? AND provider_id = ?",
  ).run(model.trim().toLowerCase(), providerId.trim().toLowerCase());
}

/** Estimasi biaya USD sebuah request dari token usage. */
export function estimateCost(
  model: string,
  providerId: string | null | undefined,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = getPrice(model, providerId);
  return (promptTokens * p.input + completionTokens * p.output) / 1_000_000;
}