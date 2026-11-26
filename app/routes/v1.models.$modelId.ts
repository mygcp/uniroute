import type { Route } from "./+types/v1.models.$modelId";
import { isValid, getSessionToken } from "../.server/auth";
import {
  isRequireApiKey,
  resolveClientKey,
  modelAllowed,
  modelBlocked,
  providerAllowed,
  providerBlocked,
  type ClientKey,
} from "../.server/client-key";
import {
  checkAccessHours,
  checkIp,
  checkScope,
  clientIpFromRequest,
  isKeyExpired,
} from "../.server/key-enforce";
import { isModelsPublic, listPublicModels } from "../.server/model-public";
import { hasColumn, query } from "../.server/db";
import { displayName, resolveDisplayToBare } from "../.server/provider-prefix";

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
  return hasColumn("models", "display_name") ? "m.display_name" : "NULL";
}

function toRow(r: Record<string, unknown>): ModelRow {
  const rec = r as unknown as ModelRow & { custom_display: string | null };
  return { ...rec, display_name: displayName(rec.prefix, rec.model_name, rec.custom_display) };
}

function findModel(displayId: string): ModelRow | undefined {
  const cc = customCol();
  if (cc !== "NULL") {
    const hit = query(
      `SELECT m.id, m.model_name, m.provider_id, m.context_length,
              p.name AS owned_by, m.is_public, p.prefix AS prefix, ${cc} AS custom_display
       FROM models m
       JOIN providers p ON p.id = m.provider_id
       WHERE m.display_name = ? AND m.is_active = 1 LIMIT 1`,
    ).get(displayId) as unknown as (ModelRow & { custom_display: string | null }) | undefined;
    if (hit) return toRow(hit);
  }

  const { bare, providerId } = resolveDisplayToBare(displayId);
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
  if (rows.length > 0) {
    const r = rows[0]!;
    return { ...r, display_name: displayName(r.prefix, r.model_name, r.custom_display) };
  }
  return undefined;
}

function isAllowedForKey(m: ModelRow, rule: ClientKey): boolean {
  if (m.is_public === 1) return true;
  if (
    (listPublicModels() as unknown as { model_name: string; display_name: string }[]).some(
      (pm) => pm.model_name === m.model_name && pm.display_name === m.display_name,
    )
  ) {
    return true;
  }
  if (!providerAllowed(rule, m.provider_id) || providerBlocked(rule, m.provider_id)) {
    return false;
  }
  if (modelBlocked(rule, m.display_name) || modelBlocked(rule, m.model_name)) {
    return false;
  }
  if (rule.allowed_models === null) return true;
  return modelAllowed(rule, m.display_name) || modelAllowed(rule, m.model_name);
}

function extractApiToken(request: Request): string | null {
  const auth = request.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  const xKey = request.headers.get("x-api-key")?.trim();
  return xKey || null;
}

export async function loader({ request, params }: Route.LoaderArgs): Promise<Response> {
  const modelId = params.modelId as string | undefined;
  if (!modelId) {
    return json({ error: { message: "model is required", type: "invalid_request_error" } }, 400);
  }

  if (isValid(getSessionToken(request))) {
    const row = findModel(modelId);
    if (!row) {
      return json({ error: { message: `model not found: ${modelId}`, type: "model_not_found" } }, 404);
    }
    return json(formatModel(row));
  }

  const token = extractApiToken(request);
  if (token) {
    const resolved = resolveClientKey(token);
    if (!resolved.ok) {
      return json({ error: { message: "invalid api key" } }, 401);
    }
    const key = resolved.key;
    if (isKeyExpired(key)) return json({ error: { message: "api key expired" } }, 403);
    const ipCheck = checkIp(key, clientIpFromRequest(request));
    if (!ipCheck.ok) return json({ error: { message: ipCheck.error } }, ipCheck.status);
    const hoursCheck = checkAccessHours(key);
    if (!hoursCheck.ok) return json({ error: { message: hoursCheck.error } }, hoursCheck.status);
    const scopeCheck = checkScope(key, "models");
    if (!scopeCheck.ok) return json({ error: { message: scopeCheck.error } }, scopeCheck.status);

    const row = findModel(modelId);
    if (!row || !isAllowedForKey(row, key)) {
      return json(
        { error: { message: `model not found: ${modelId}`, type: "model_not_found" } },
        404,
      );
    }
    return json(formatModel(row));
  }

  if (isModelsPublic()) {
    const row = findModel(modelId);
    if (!row || row.is_public !== 1) {
      return json(
        { error: { message: `model not found: ${modelId}`, type: "model_not_found" } },
        404,
      );
    }
    return json(formatModel(row));
  }

  if (!isRequireApiKey()) {
    const row = findModel(modelId);
    if (!row) {
      return json(
        { error: { message: `model not found: ${modelId}`, type: "model_not_found" } },
        404,
      );
    }
    return json(formatModel(row));
  }

  return json({ error: { message: "api key required" } }, 401);
}
