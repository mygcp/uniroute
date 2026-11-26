import type { Route } from "./+types/api.show";
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

function customCol(): string {
  return hasColumn("models", "display_name") ? "m.display_name" : "NULL";
}

function findModel(name: string): ModelRow | undefined {
  const cc = customCol();
  if (cc !== "NULL") {
    const hit = query(
      `SELECT m.id, m.model_name, m.provider_id, m.context_length,
              p.name AS owned_by, m.is_public, p.prefix AS prefix, ${cc} AS custom_display
       FROM models m
       JOIN providers p ON p.id = m.provider_id
       WHERE m.display_name = ? AND m.is_active = 1 LIMIT 1`,
    ).get(name) as unknown as (ModelRow & { custom_display: string | null }) | undefined;
    if (hit) {
      return { ...hit, display_name: displayName(hit.prefix, hit.model_name, hit.custom_display) };
    }
  }
  const { bare, providerId } = resolveDisplayToBare(name);
  if (providerId) {
    const row = query(
      `SELECT m.id, m.model_name, m.provider_id, m.context_length,
              p.name AS owned_by, m.is_public, p.prefix AS prefix, ${cc} AS custom_display
       FROM models m
       JOIN providers p ON p.id = m.provider_id
       WHERE m.model_name = ? AND m.provider_id = ? AND m.is_active = 1`,
    ).get(bare, providerId) as unknown as (ModelRow & { custom_display: string | null }) | undefined;
    if (row) return { ...row, display_name: displayName(row.prefix, row.model_name, row.custom_display) };
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
    if (disp === name || r.model_name === name) return { ...r, display_name: disp };
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
      (pm) => pm.display_name === m.display_name,
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

function toOllamaShow(m: ModelRow): Record<string, unknown> {
  return {
    modelfile: `# Modelfile for ${m.display_name}\nFROM ${m.display_name}`,
    parameters: "",
    template: "",
    details: {
      parent_model: "",
      format: "",
      family: m.owned_by,
      families: [m.owned_by],
      parameter_size: "",
      quantization_level: "",
    },
    model_info: {
      general: {
        architecture: m.model_name,
        parameter_size: "",
      },
    },
    id: m.display_name,
    object: "model",
    owned_by: m.owned_by,
    name: m.display_name,
    model: m.display_name,
  };
}

function extractApiToken(request: Request): string | null {
  const auth = request.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  const xKey = request.headers.get("x-api-key")?.trim();
  return xKey || null;
}

async function handle(request: Request): Promise<Response> {
  let name: string | null = null;

  if (request.method === "POST") {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      const raw = body.model ?? body.name ?? body.model_name;
      if (typeof raw === "string" && raw.trim()) name = raw.trim();
    } catch {
      /* ignore */
    }
  }

  if (!name) {
    try {
      const url = new URL(request.url);
      const q = url.searchParams.get("model") ?? url.searchParams.get("name");
      if (q) name = q.trim();
    } catch {
      /* ignore */
    }
  }

  if (!name) {
    return json({ error: "model is required" }, 400);
  }

  if (isValid(getSessionToken(request))) {
    const row = findModel(name);
    if (!row) return json({ error: `model '${name}' not found` }, 404);
    return json(toOllamaShow(row));
  }

  const token = extractApiToken(request);
  if (token) {
    const resolved = resolveClientKey(token);
    if (!resolved.ok) return json({ error: "invalid api key" }, 401);
    const key = resolved.key;
    if (isKeyExpired(key)) return json({ error: "api key expired" }, 403);
    const ipCheck = checkIp(key, clientIpFromRequest(request));
    if (!ipCheck.ok) return json({ error: ipCheck.error }, ipCheck.status);
    const hoursCheck = checkAccessHours(key);
    if (!hoursCheck.ok) return json({ error: hoursCheck.error }, hoursCheck.status);
    const scopeCheck = checkScope(key, "models");
    if (!scopeCheck.ok) return json({ error: scopeCheck.error }, scopeCheck.status);

    const row = findModel(name);
    if (!row || !isAllowedForKey(row, key)) {
      return json({ error: `model '${name}' not found` }, 404);
    }
    return json(toOllamaShow(row));
  }

  if (isModelsPublic()) {
    const row = findModel(name);
    if (!row || row.is_public !== 1) {
      return json({ error: `model '${name}' not found` }, 404);
    }
    return json(toOllamaShow(row));
  }

  if (!isRequireApiKey()) {
    const row = findModel(name);
    if (!row) return json({ error: `model '${name}' not found` }, 404);
    return json(toOllamaShow(row));
  }

  return json({ error: "api key required" }, 401);
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  return handle(request);
}

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  return handle(request);
}
