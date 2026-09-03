import type { Route } from "./+types/v1.models";
import { isValid, getSessionToken } from "../.server/auth";
import {
  isRequireApiKey,
  resolveClientKey,
  modelAllowed,
  type ClientKey,
} from "../.server/client-key";
import { isModelsPublic, listPublicModels } from "../.server/model-public";
import { query } from "../.server/db";
import { displayName } from "../.server/provider-prefix";

type ModelRow = {
  id: number;
  model_name: string;
  display_name: string;
  provider_id: string;
  context_length: number | null;
  owned_by: string;
  prefix: string | null;
};

function customCol(): string {
  try {
    const cols = (query("PRAGMA table_info(models)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    if (cols.includes("display_name")) return "m.display_name";
  } catch {
    /* ignore */
  }
  return "NULL";
}

function allActiveModels(): ModelRow[] {
  const cc = customCol();
  const rows = query(
    `SELECT m.id, m.model_name, m.provider_id, m.context_length,
            p.name AS owned_by, p.prefix AS prefix, ${cc} AS custom_display
     FROM models m
     JOIN providers p ON p.id = m.provider_id
     WHERE m.is_active = 1
     ORDER BY m.model_name`,
  ).all() as unknown as { id: number; model_name: string; provider_id: string; context_length: number | null; owned_by: string; prefix: string | null; custom_display: string | null }[];
  return rows.map((r) => ({
    ...r,
    display_name: displayName(r.prefix, r.model_name, r.custom_display),
  }));
}

function modelsAllowedByKey(rule: ClientKey): ModelRow[] {
  return allActiveModels().filter(
    (m) =>
      rule.allowed_models === null ||
      modelAllowed(rule, m.display_name) ||
      modelAllowed(rule, m.model_name),
  );
}

function unionIds(...lists: ModelRow[][]): ModelRow[] {
  const seen = new Set<number>();
  const out: ModelRow[] = [];
  for (const list of lists) {
    for (const m of list) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
      }
    }
  }
  return out.sort((a, b) => a.display_name.localeCompare(b.display_name));
}

function formatModel(m: ModelRow): Record<string, unknown> {
  return {
    id: m.display_name,
    object: "model" as const,
    created: 0,
    owned_by: m.owned_by,
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  if (isValid(getSessionToken(request))) {
    return json({ object: "list", data: allActiveModels().map(formatModel) });
  }

  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : null;

  if (token) {
    const resolved = resolveClientKey(token);
    if (!resolved.ok) {
      return json({ error: { message: "invalid api key" } }, 401);
    }
    const models = unionIds(
      // listPublicModels already returns display_name aware, cast to ModelRow
      listPublicModels() as unknown as ModelRow[],
      modelsAllowedByKey(resolved.key),
    );
    return json({ object: "list", data: models.map(formatModel) });
  }

  if (isModelsPublic()) {
    return json({ object: "list", data: (listPublicModels() as unknown as ModelRow[]).map(formatModel) });
  }

  return json({ error: { message: "api key required" } }, isRequireApiKey() ? 401 : 403);
}
