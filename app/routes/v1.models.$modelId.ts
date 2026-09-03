import type { Route } from "./+types/v1.models.$modelId";
import { isValid, getSessionToken } from "../.server/auth";
import {
  isRequireApiKey,
  resolveClientKey,
  modelAllowed,
  type ClientKey,
} from "../.server/client-key";
import { isModelsPublic, listPublicModels } from "../.server/model-public";
import { query } from "../.server/db";
import { displayName, resolveDisplayToBare, modelNotFoundBody } from "../.server/provider-prefix";

type ModelRow = {
  id: number;
  model_name: string;
  display_name: string;
  provider_id: string;
  context_length: number | null;
  owned_by: string;
  is_public: number;
  prefix: string | null;
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function formatModel(m: ModelRow): Record<string, unknown> {
  return {
    id: m.display_name,
    object: "model" as const,
    created: 0,
    owned_by: m.owned_by,
  };
}

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

function toRow(r: Record<string, unknown>): ModelRow {
  const rec = r as unknown as ModelRow & { custom_display: string | null };
  return { ...rec, display_name: displayName(rec.prefix, rec.model_name, rec.custom_display) };
}

function findModel(displayId: string): ModelRow | undefined {
  const cc = customCol();
  // 1) custom display_name exact (per-model override)
  try {
    const hit = query(
      `SELECT m.id, m.model_name, m.provider_id, m.context_length,
              p.name AS owned_by, m.is_public, p.prefix AS prefix, ${cc} AS custom_display
       FROM models m
       JOIN providers p ON p.id = m.provider_id
       WHERE m.display_name = ? AND m.is_active = 1 LIMIT 1`,
    ).get(displayId) as unknown as (ModelRow & { custom_display: string | null }) | undefined;
    if (hit) return toRow(hit);
  } catch {
    /* kolom belum ada -> lanjut */
  }

  const { bare, providerId } = resolveDisplayToBare(displayId);
  // bila prefix/custom menunjuk provider spesifik, cari tepat di provider itu
  if (providerId) {
    const row = query(
      `SELECT m.id, m.model_name, m.provider_id, m.context_length,
              p.name AS owned_by, m.is_public, p.prefix AS prefix, ${cc} AS custom_display
       FROM models m
       JOIN providers p ON p.id = m.provider_id
       WHERE m.model_name = ? AND m.provider_id = ? AND m.is_active = 1`,
    ).get(bare, providerId) as unknown as (ModelRow & { custom_display: string | null }) | undefined;
    if (row) return toRow(row);
  }
  // fallback: cari berdasar bare tanpa hint, atau bila prefix tidak match
  // cari semua aktif dengan bare, lalu pilih yang prefix-nya cocok dengan displayId
  const rows = query(
    `SELECT m.id, m.model_name, m.provider_id, m.context_length,
            p.name AS owned_by, m.is_public, p.prefix AS prefix, ${cc} AS custom_display
     FROM models m
     JOIN providers p ON p.id = m.provider_id
     WHERE m.model_name = ? AND m.is_active = 1`,
  ).all(bare) as unknown as (ModelRow & { custom_display: string | null })[];
  for (const r of rows) {
    const disp = displayName(r.prefix, r.model_name, r.custom_display);
    if (disp === displayId || r.model_name === displayId) {
      return { ...r, display_name: disp };
    }
  }
  // bila tidak ketemu exact, kembalikan yang pertama (kompatibilitas bare)
  if (rows.length > 0) {
    const r = rows[0]!;
    return { ...r, display_name: displayName(r.prefix, r.model_name, r.custom_display) };
  }
  return undefined;
}

function isAllowedForKey(m: ModelRow, rule: ClientKey): boolean {
  const isPublic =
    (listPublicModels() as unknown as { model_name: string; display_name: string }[]).some(
      (pm) => pm.model_name === m.model_name && pm.display_name === m.display_name,
    ) || m.is_public === 1;
  if (isPublic) return true;
  if (rule.allowed_models === null) return true;
  return modelAllowed(rule, m.display_name) || modelAllowed(rule, m.model_name);
}

export async function loader({ request, params }: Route.LoaderArgs): Promise<Response> {
  const modelId = params.modelId as string | undefined;
  if (!modelId) {
    return json({ error: { message: "model is required", type: "invalid_request_error" } }, 400);
  }

  const row = findModel(modelId);
  if (!row) {
    return json({ error: modelNotFoundBody(modelId) }, 404);
  }

  if (isValid(getSessionToken(request))) {
    return json(formatModel(row));
  }

  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : null;

  if (token) {
    const resolved = resolveClientKey(token);
    if (!resolved.ok) {
      return json({ error: { message: "invalid api key" } }, 401);
    }
    if (!isAllowedForKey(row, resolved.key)) {
      return json(
        { error: { message: `model not found: ${modelId}`, type: "model_not_found" } },
        404,
      );
    }
    return json(formatModel(row));
  }

  if (isModelsPublic()) {
    if (row.is_public !== 1) {
      return json(
        { error: { message: `model not found: ${modelId}`, type: "model_not_found" } },
        404,
      );
    }
    return json(formatModel(row));
  }

  if (!isRequireApiKey()) {
    return json(formatModel(row));
  }

  return json({ error: { message: "api key required" } }, isRequireApiKey() ? 401 : 403);
}
