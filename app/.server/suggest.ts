import { listCombos } from "./combo";
import { query } from "./db";

/** Distinct model names already present in the system, for form suggestions. */
export function getModelSuggestions(): string[] {
  const rows = query(
    `SELECT model_name AS model FROM models WHERE is_active = 1
     UNION
     SELECT model_name FROM model_allowlist
     UNION
     SELECT source_model FROM routing_rules
     UNION
     SELECT target_model FROM routing_rules
     WHERE target_model IS NOT NULL AND target_model <> ''
     UNION
     SELECT model_override FROM client_api_keys
     WHERE model_override IS NOT NULL AND model_override <> ''`,
  ).all() as unknown as { model: string }[];

  const keyRows = query(
    "SELECT allowed_models FROM client_api_keys WHERE allowed_models IS NOT NULL",
  ).all() as unknown as { allowed_models: string }[];

  const unique = new Set<string>();
  for (const row of rows) {
    const model = row.model?.trim();
    if (model) unique.add(model);
  }
  for (const row of keyRows) {
    try {
      const parsed = JSON.parse(row.allowed_models);
      if (Array.isArray(parsed)) {
        for (const m of parsed) {
          if (typeof m === "string" && m.trim()) unique.add(m.trim());
        }
      }
    } catch {
      /* skip malformed JSON */
    }
  }
  return [...unique].sort((a, b) => a.localeCompare(b));
}

/** Provider ids configured in the system, for form suggestions. */
export function getProviderSuggestions(): string[] {
  const rows = query("SELECT id FROM providers ORDER BY id").all() as unknown as {
    id: string;
  }[];
  return rows.map((r) => r.id).filter(Boolean);
}

export type TagSuggestion =
  | { value: string; type: "model"; provider?: string }
  | { value: string; type: "combo" };

/** Suggestions for the Allowed/Blocked Models tag input: models + combos. */
export function getStructuredSuggestions(): TagSuggestion[] {
  const modelRows = query(
    `SELECT m.model_name AS model, m.provider_id AS provider
     FROM models m WHERE m.is_active = 1`,
  ).all() as unknown as { model: string; provider: string }[];

  const extraRows = query(
    `SELECT model_name AS model FROM model_allowlist
     UNION
     SELECT source_model FROM routing_rules
     UNION
     SELECT target_model FROM routing_rules WHERE target_model IS NOT NULL AND target_model != ''
     UNION
     SELECT model_override FROM client_api_keys WHERE model_override IS NOT NULL AND model_override != ''`,
  ).all() as unknown as { model: string }[];

  const keyRows = query(
    "SELECT allowed_models FROM client_api_keys WHERE allowed_models IS NOT NULL",
  ).all() as unknown as { allowed_models: string }[];

  const byName = new Map<string, TagSuggestion>();
  for (const row of modelRows) {
    const name = row.model?.trim();
    if (!name) continue;
    const existing = byName.get(name);
    const provider = row.provider?.trim() || undefined;
    if (!existing || (existing.type === "model" && !existing.provider)) {
      byName.set(name, { value: name, type: "model", provider });
    }
  }

  const addExtra = (name: unknown): void => {
    const clean = typeof name === "string" ? name.trim() : "";
    if (!clean) return;
    if (!byName.has(clean)) byName.set(clean, { value: clean, type: "model" });
  };

  for (const row of extraRows) addExtra(row.model);
  for (const row of keyRows) {
    try {
      const parsed = JSON.parse(row.allowed_models);
      if (Array.isArray(parsed)) for (const m of parsed) addExtra(m);
    } catch {
      /* skip malformed JSON */
    }
  }

  const models = [...byName.values()].sort((a, b) => a.value.localeCompare(b.value));
  const combos = listCombos()
    .map((c): TagSuggestion => ({ value: `combo:${c.name}`, type: "combo" }))
    .sort((a, b) => a.value.localeCompare(b.value));
  return [...models, ...combos];
}
