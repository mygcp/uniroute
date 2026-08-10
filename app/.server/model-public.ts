import { query } from "./db";

export type PublicModel = {
  id: number;
  model_name: string;
  provider_id: string;
  context_length: number | null;
  owned_by: string;
  created_at: number;
};

type PublicModelRow = {
  id: number;
  model_name: string;
  provider_id: string;
  context_length: number | null;
  owned_by: string;
};

const MODELS_PUBLIC_SETTING = "models_public";

export function isModelsPublic(): boolean {
  const row = query("SELECT value FROM settings WHERE key = ?").get(
    MODELS_PUBLIC_SETTING,
  ) as { value: string } | undefined;
  return row?.value === "1";
}

export function setModelsPublic(enabled: boolean): void {
  query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(MODELS_PUBLIC_SETTING, enabled ? "1" : "0");
}

export function setModelPublic(modelId: number, enabled: boolean): void {
  query("UPDATE models SET is_public = ? WHERE id = ?").run(enabled ? 1 : 0, modelId);
}

export function listPublicModels(): PublicModel[] {
  const rows = query(
    `SELECT m.id, m.model_name, m.provider_id, m.context_length,
            p.name AS owned_by
     FROM models m
     JOIN providers p ON p.id = m.provider_id
     WHERE m.is_active = 1 AND m.is_public = 1
     ORDER BY m.model_name`,
  ).all() as unknown as PublicModelRow[];
  return rows.map((r) => ({
    id: r.id,
    model_name: r.model_name,
    provider_id: r.provider_id,
    context_length: r.context_length,
    owned_by: r.owned_by,
    created_at: 0,
  }));
}
