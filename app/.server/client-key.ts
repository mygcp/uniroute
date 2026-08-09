import { createHash } from "node:crypto";
import { query } from "./db";

export type ClientKey = {
  id: number;
  name: string;
  key_hash: string;
  key_prefix: string;
  allowed_models: string[] | null;
  model_override: string | null;
  pinned_provider_id: string | null;
  is_active: number;
};

type ClientKeyRow = {
  id: number;
  name: string;
  key_hash: string;
  key_prefix: string;
  allowed_models: string | null;
  model_override: string | null;
  pinned_provider_id: string | null;
  is_active: number;
};

function toClientKey(row: ClientKeyRow): ClientKey {
  let allowedModels: string[] | null = null;
  if (row.allowed_models) {
    try {
      const parsed = JSON.parse(row.allowed_models);
      if (Array.isArray(parsed)) allowedModels = parsed.filter((m) => typeof m === "string");
    } catch {
      allowedModels = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    key_hash: row.key_hash,
    key_prefix: row.key_prefix,
    allowed_models: allowedModels,
    model_override: row.model_override,
    pinned_provider_id: row.pinned_provider_id,
    is_active: row.is_active,
  };
}

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sk-${hex}`;
}

export type CreateClientKeyInput = {
  name: string;
  allowedModels?: string[] | null;
  modelOverride?: string | null;
  pinnedProviderId?: string | null;
};

export function createClientKey(input: CreateClientKeyInput): { key: string; id: number } {
  const key = generateKey();
  const allowed = Array.isArray(input.allowedModels) && input.allowedModels.length > 0
    ? JSON.stringify(input.allowedModels)
    : null;
  const res = query(
    `INSERT INTO client_api_keys (name, key_hash, key_prefix, allowed_models, model_override, pinned_provider_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.name,
    hashKey(key),
    key.slice(0, 8),
    allowed,
    input.modelOverride?.trim() ? input.modelOverride.trim() : null,
    input.pinnedProviderId?.trim() ? input.pinnedProviderId.trim() : null,
  ) as { lastInsertRowid?: number };
  return { key, id: Number(res.lastInsertRowid) };
}

export function getClientKeyById(id: number): ClientKey | undefined {
  const row = query(
    "SELECT id, name, key_hash, key_prefix, allowed_models, model_override, pinned_provider_id, is_active FROM client_api_keys WHERE id = ?",
  ).get(id) as ClientKeyRow | undefined;
  return row ? toClientKey(row) : undefined;
}

export function listClientKeys(): ClientKey[] {
  const rows = query(
    "SELECT id, name, key_hash, key_prefix, allowed_models, model_override, pinned_provider_id, is_active FROM client_api_keys ORDER BY id DESC",
  ).all() as unknown as ClientKeyRow[];
  return rows.map(toClientKey);
}

export function setClientKeyActive(id: number, active: boolean): void {
  query("UPDATE client_api_keys SET is_active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

export type UpdateClientKeyInput = {
  name?: string;
  allowedModels?: string[] | null;
  modelOverride?: string | null;
  pinnedProviderId?: string | null;
};

export function updateClientKeyRules(id: number, input: UpdateClientKeyInput): void {
  const current = getClientKeyById(id);
  if (!current) return;

  const name = input.name?.trim() ? input.name.trim() : current.name;
  const models =
    Array.isArray(input.allowedModels) && input.allowedModels.length > 0
      ? JSON.stringify(input.allowedModels)
      : null;
  const override = input.modelOverride?.trim()
    ? input.modelOverride.trim()
    : null;
  const pinned = input.pinnedProviderId?.trim()
    ? input.pinnedProviderId.trim()
    : null;

  query(
    `UPDATE client_api_keys
     SET name = ?, allowed_models = ?, model_override = ?, pinned_provider_id = ?
     WHERE id = ?`,
  ).run(name, models, override, pinned, id);
}

export function deleteClientKey(id: number): void {
  query("DELETE FROM client_api_keys WHERE id = ?").run(id);
}

export type ResolveResult =
  | { ok: true; key: ClientKey }
  | { ok: false; status: number; message: string };

export function resolveClientKey(token: string | null | undefined): ResolveResult {
  if (!token) {
    return { ok: false, status: 401, message: "api key required" };
  }
  const row = query(
    "SELECT id, name, key_hash, key_prefix, allowed_models, model_override, pinned_provider_id, is_active FROM client_api_keys WHERE key_hash = ?",
  ).get(hashKey(token)) as ClientKeyRow | undefined;
  if (!row) {
    return { ok: false, status: 401, message: "invalid api key" };
  }
  if (row.is_active !== 1) {
    return { ok: false, status: 401, message: "invalid api key" };
  }
  return { ok: true, key: toClientKey(row) };
}

export function modelAllowed(key: ClientKey, model: string): boolean {
  if (!key.allowed_models || key.allowed_models.length === 0) return true;
  return key.allowed_models.some((prefix) => model.startsWith(prefix));
}

const REQUIRE_KEY_SETTING = "require_api_key";

export function isRequireApiKey(): boolean {
  const row = query("SELECT value FROM settings WHERE key = ?").get(
    REQUIRE_KEY_SETTING,
  ) as { value: string } | undefined;
  return row?.value === "1";
}

export function setRequireApiKey(enabled: boolean): void {
  query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(REQUIRE_KEY_SETTING, enabled ? "1" : "0");
}
