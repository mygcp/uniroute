import { hasColumn, query } from "./db";
import { displayName } from "./provider-prefix";
import { getCachedSetting, setCachedSetting } from "./settings-cache";

export type PublicModel = {
  id: number;
  model_name: string;
  display_name: string;
  provider_id: string;
  context_length: number | null;
  owned_by: string;
  prefix: string | null;
  created_at: number;
};

type PublicModelRow = {
  id: number;
  model_name: string;
  provider_id: string;
  context_length: number | null;
  owned_by: string;
  prefix: string | null;
  custom_display: string | null;
};

const MODELS_PUBLIC_SETTING = "models_public";

export function isModelsPublic(): boolean {
  return getCachedSetting(MODELS_PUBLIC_SETTING) === "1";
}

export function setModelsPublic(enabled: boolean): void {
  setCachedSetting(MODELS_PUBLIC_SETTING, enabled ? "1" : "0");
}

export function setModelPublic(modelId: number, enabled: boolean): void {
  query("UPDATE models SET is_public = ? WHERE id = ?").run(enabled ? 1 : 0, modelId);
}

export function listPublicModels(): PublicModel[] {
  const customCol = hasColumn("models", "display_name") ? "m.display_name" : "NULL";
  const rows = query(
    `SELECT m.id, m.model_name, m.provider_id, m.context_length,
            p.name AS owned_by, p.prefix AS prefix, ${customCol} AS custom_display
     FROM models m
     JOIN providers p ON p.id = m.provider_id
     WHERE m.is_active = 1 AND m.is_public = 1
     ORDER BY m.model_name`,
  ).all() as unknown as PublicModelRow[];
  return rows.map((r) => ({
    id: r.id,
    model_name: r.model_name,
    display_name: displayName(r.prefix, r.model_name, r.custom_display),
    provider_id: r.provider_id,
    context_length: r.context_length,
    owned_by: r.owned_by,
    prefix: r.prefix ?? null,
    created_at: 0,
  }));
}
