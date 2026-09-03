import type { Route } from "./+types/api.show";
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

function findModel(name: string): ModelRow | undefined {
  const cc = customCol();
  try {
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
  } catch {
    /* ignore */
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
  const isPublic =
    (listPublicModels() as unknown as { model_name: string; display_name: string }[]).some(
      (pm) => pm.display_name === m.display_name,
    ) || m.is_public === 1;
  if (isPublic) return true;
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
    // Extra fields for compatibility with clients expecting OpenAI shape too
    id: m.display_name,
    object: "model",
    owned_by: m.owned_by,
    name: m.display_name,
    model: m.display_name,
  };
}

async function handle(request: Request): Promise<Response> {
  let name: string | null = null;

  // Try JSON body first (Ollama POST {"model":"..."} or {"name":"..."})
  if (request.method === "POST") {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      const raw = body.model ?? body.name ?? body.model_name;
      if (typeof raw === "string" && raw.trim()) name = raw.trim();
    } catch {
      // ignore, fallback to query param
    }
  }

  // Fallback: query param ?model= or URL search
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

  const row = findModel(name);
  if (!row) {
    const err = modelNotFoundBody(name);
    return json({ error: err.message }, 404);
  }

  // Auth: mirror v1.models logic but permissive when not requiring key
  if (isValid(getSessionToken(request))) {
    return json(toOllamaShow(row));
  }

  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : null;

  if (token) {
    const resolved = resolveClientKey(token);
    if (!resolved.ok) return json({ error: "invalid api key" }, 401);
    if (!isAllowedForKey(row, resolved.key)) {
      return json({ error: `model '${name}' not found` }, 404);
    }
    return json(toOllamaShow(row));
  }

  if (isModelsPublic()) {
    if (row.is_public !== 1) {
      return json({ error: `model '${name}' not found` }, 404);
    }
    return json(toOllamaShow(row));
  }

  if (!isRequireApiKey()) {
    return json(toOllamaShow(row));
  }

  return json({ error: "api key required" }, 401);
}

export async function action({ request }: Route.ActionArgs): Promise<Response> {
  return handle(request);
}

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  // Ollama clients use POST, but support GET for browser/curl probing
  if (request.method === "POST") return handle(request);
  return handle(request);
}
