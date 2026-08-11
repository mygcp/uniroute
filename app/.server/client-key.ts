import { createHash } from "node:crypto";
import { query } from "./db";
import { encryptKey } from "./key-crypto";

export type BudgetConfig = {
  monthly?: number;
  daily?: number;
  per_request?: number;
};

export type QuotaConfig = {
  tokens_per_month?: number;
  requests_per_day?: number;
  concurrent_requests?: number;
  rpm?: number;
  tpm?: number;
};

export type AccessHoursConfig = {
  enabled?: boolean;
  timezone?: string;
  allowed_days?: string[];
  start_time?: string;
  end_time?: string;
};

export type ClientKey = {
  id: number;
  name: string;
  key_hash: string;
  key_prefix: string;
  allowed_models: string[] | null;
  model_override: string | null;
  pinned_provider_id: string | null;
  is_active: number;
  created_at?: number;
  description: string | null;
  key_enc: string | null;
  previous_key_hash: string | null;
  previous_key_enc: string | null;
  previous_expires_at: number | null;
  blocked_models: string[] | null;
  allowed_providers: string[] | null;
  blocked_providers: string[] | null;
  budget: BudgetConfig | null;
  quota: QuotaConfig | null;
  alert_threshold: number | null;
  auto_block: number;
  blocked_at: number | null;
  ip_whitelist: string[] | null;
  ip_blacklist: string[] | null;
  strict_ip: number;
  access_hours: AccessHoursConfig | null;
  expires_at: number | null;
  rotation_interval_days: number | null;
  grace_period_days: number | null;
  webhook_url: string | null;
  scopes: string[] | null;
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
  created_at: number;
  description: string | null;
  key_enc: string | null;
  previous_key_hash: string | null;
  previous_key_enc: string | null;
  previous_expires_at: number | null;
  blocked_models: string | null;
  allowed_providers: string | null;
  blocked_providers: string | null;
  budget: string | null;
  quota: string | null;
  alert_threshold: number | null;
  auto_block: number;
  blocked_at: number | null;
  ip_whitelist: string | null;
  ip_blacklist: string | null;
  strict_ip: number;
  access_hours: string | null;
  expires_at: number | null;
  rotation_interval_days: number | null;
  grace_period_days: number | null;
  webhook_url: string | null;
  scopes: string | null;
};

const COLUMNS = [
  "id",
  "name",
  "key_hash",
  "key_prefix",
  "allowed_models",
  "model_override",
  "pinned_provider_id",
  "is_active",
  "created_at",
  "description",
  "key_enc",
  "previous_key_hash",
  "previous_key_enc",
  "previous_expires_at",
  "blocked_models",
  "allowed_providers",
  "blocked_providers",
  "budget",
  "quota",
  "alert_threshold",
  "auto_block",
  "blocked_at",
  "ip_whitelist",
  "ip_blacklist",
  "strict_ip",
  "access_hours",
  "expires_at",
  "rotation_interval_days",
  "grace_period_days",
  "webhook_url",
  "scopes",
].join(", ");

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseStringArray(raw: string | null | undefined): string[] | null {
  const parsed = parseJson<unknown>(raw);
  if (!Array.isArray(parsed)) return null;
  const list = parsed.filter((v): v is string => typeof v === "string");
  return list.length > 0 ? list : null;
}

function toClientKey(row: ClientKeyRow): ClientKey {
  return {
    id: row.id,
    name: row.name,
    key_hash: row.key_hash,
    key_prefix: row.key_prefix,
    allowed_models: parseStringArray(row.allowed_models),
    model_override: row.model_override,
    pinned_provider_id: row.pinned_provider_id,
    is_active: row.is_active,
    created_at: row.created_at,
    description: row.description,
    key_enc: row.key_enc,
    previous_key_hash: row.previous_key_hash,
    previous_key_enc: row.previous_key_enc,
    previous_expires_at: row.previous_expires_at,
    blocked_models: parseStringArray(row.blocked_models),
    allowed_providers: parseStringArray(row.allowed_providers),
    blocked_providers: parseStringArray(row.blocked_providers),
    budget: parseJson<BudgetConfig>(row.budget),
    quota: parseJson<QuotaConfig>(row.quota),
    alert_threshold: row.alert_threshold,
    auto_block: row.auto_block,
    blocked_at: row.blocked_at,
    ip_whitelist: parseStringArray(row.ip_whitelist),
    ip_blacklist: parseStringArray(row.ip_blacklist),
    strict_ip: row.strict_ip,
    access_hours: parseJson<AccessHoursConfig>(row.access_hours),
    expires_at: row.expires_at,
    rotation_interval_days: row.rotation_interval_days,
    grace_period_days: row.grace_period_days,
    webhook_url: row.webhook_url,
    scopes: parseStringArray(row.scopes),
  };
}

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateKey(prefix = "sk-"): string {
  const normalized = normalizePrefix(prefix);
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${normalized}${hex}`;
}

export function normalizePrefix(prefix: string | null | undefined): string {
  const trimmed = (prefix ?? "sk-").trim();
  if (!trimmed) return "sk-";
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : "sk-";
}

export type CreateClientKeyInput = {
  name: string;
  prefix?: string | null;
  description?: string | null;
  allowedModels?: string[] | null;
  modelOverride?: string | null;
  pinnedProviderId?: string | null;
  blockedModels?: string[] | null;
  allowedProviders?: string[] | null;
  blockedProviders?: string[] | null;
  budget?: BudgetConfig | null;
  quota?: QuotaConfig | null;
  alertThreshold?: number | null;
  autoBlock?: boolean;
  ipWhitelist?: string[] | null;
  ipBlacklist?: string[] | null;
  strictIp?: boolean;
  accessHours?: AccessHoursConfig | null;
  expiresAt?: number | null;
  rotationIntervalDays?: number | null;
  gracePeriodDays?: number | null;
  webhookUrl?: string | null;
  scopes?: string[] | null;
  noEncrypt?: boolean;
};

function jsonOrNull<T>(value: T[] | null | undefined): string | null {
  return Array.isArray(value) && value.length > 0 ? JSON.stringify(value) : null;
}

export function createClientKey(input: CreateClientKeyInput): { key: string; id: number } {
  const prefix = normalizePrefix(input.prefix);
  const key = generateKey(prefix);
  const allowed = jsonOrNull(input.allowedModels);
  const budget =
    input.budget && Object.keys(input.budget).length > 0 ? JSON.stringify(input.budget) : null;
  const quota =
    input.quota && Object.keys(input.quota).length > 0 ? JSON.stringify(input.quota) : null;
  const accessHours =
    input.accessHours && Object.keys(input.accessHours).length > 0
      ? JSON.stringify(input.accessHours)
      : null;
  const keyEnc = input.noEncrypt ? null : encryptKey(key);
  const res = query(
    `INSERT INTO client_api_keys
       (name, key_hash, key_prefix, allowed_models, model_override, pinned_provider_id,
        description, key_enc, blocked_models, allowed_providers, blocked_providers,
        budget, quota, alert_threshold, auto_block, ip_whitelist, ip_blacklist, strict_ip,
        access_hours, expires_at, rotation_interval_days, grace_period_days, webhook_url, scopes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.name,
    hashKey(key),
    prefix,
    allowed,
    input.modelOverride?.trim() ? input.modelOverride.trim() : null,
    input.pinnedProviderId?.trim() ? input.pinnedProviderId.trim() : null,
    input.description?.trim() ? input.description.trim() : null,
    keyEnc,
    jsonOrNull(input.blockedModels),
    jsonOrNull(input.allowedProviders),
    jsonOrNull(input.blockedProviders),
    budget,
    quota,
    input.alertThreshold ?? null,
    input.autoBlock ? 1 : 0,
    jsonOrNull(input.ipWhitelist),
    jsonOrNull(input.ipBlacklist),
    input.strictIp ? 1 : 0,
    accessHours,
    input.expiresAt ?? null,
    input.rotationIntervalDays ?? null,
    input.gracePeriodDays ?? null,
    input.webhookUrl?.trim() ? input.webhookUrl.trim() : null,
    jsonOrNull(input.scopes),
  ) as { lastInsertRowid?: number };
  return { key, id: Number(res.lastInsertRowid) };
}

function getRowById(id: number): ClientKeyRow | undefined {
  return query(
    `SELECT ${COLUMNS} FROM client_api_keys WHERE id = ?`,
  ).get(id) as ClientKeyRow | undefined;
}

export function getClientKeyById(id: number): ClientKey | undefined {
  const row = getRowById(id);
  return row ? toClientKey(row) : undefined;
}

export function listClientKeys(): ClientKey[] {
  const rows = query(
    `SELECT ${COLUMNS} FROM client_api_keys ORDER BY id DESC`,
  ).all() as unknown as ClientKeyRow[];
  return rows.map(toClientKey);
}

export function setClientKeyActive(id: number, active: boolean): void {
  query("UPDATE client_api_keys SET is_active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

export function setClientKeyBlocked(id: number, blockedAt: number | null): void {
  query("UPDATE client_api_keys SET blocked_at = ? WHERE id = ?").run(blockedAt, id);
}

export type UpdateClientKeyInput = {
  name?: string;
  description?: string | null;
  allowedModels?: string[] | null;
  modelOverride?: string | null;
  pinnedProviderId?: string | null;
  blockedModels?: string[] | null;
  allowedProviders?: string[] | null;
  blockedProviders?: string[] | null;
  budget?: BudgetConfig | null;
  quota?: QuotaConfig | null;
  alertThreshold?: number | null;
  autoBlock?: boolean;
  ipWhitelist?: string[] | null;
  ipBlacklist?: string[] | null;
  strictIp?: boolean;
  accessHours?: AccessHoursConfig | null;
  expiresAt?: number | null;
  rotationIntervalDays?: number | null;
  gracePeriodDays?: number | null;
  webhookUrl?: string | null;
  scopes?: string[] | null;
};

function pick<T>(input: T | undefined, fallback: T): T {
  return input === undefined ? fallback : input;
}

export function updateClientKey(id: number, input: UpdateClientKeyInput): void {
  const current = getClientKeyById(id);
  if (!current) return;

  const name = input.name?.trim() ? input.name.trim() : current.name;
  const jsonOrSel = <T>(v: T[] | null | undefined, cur: T[] | null): string | null =>
    v === undefined ? jsonOrNull(cur) : jsonOrNull(v);

  query(
    `UPDATE client_api_keys SET
       name = ?, description = ?, allowed_models = ?, model_override = ?, pinned_provider_id = ?,
       blocked_models = ?, allowed_providers = ?, blocked_providers = ?,
       budget = ?, quota = ?, alert_threshold = ?, auto_block = ?,
       ip_whitelist = ?, ip_blacklist = ?, strict_ip = ?, access_hours = ?,
       expires_at = ?, rotation_interval_days = ?, grace_period_days = ?, webhook_url = ?, scopes = ?
     WHERE id = ?`,
  ).run(
    name,
    input.description === undefined
      ? current.description
      : input.description?.trim() || null,
    jsonOrSel(input.allowedModels, current.allowed_models),
    pick(input.modelOverride, current.model_override)?.trim() || null,
    pick(input.pinnedProviderId, current.pinned_provider_id)?.trim() || null,
    jsonOrSel(input.blockedModels, current.blocked_models),
    jsonOrSel(input.allowedProviders, current.allowed_providers),
    jsonOrSel(input.blockedProviders, current.blocked_providers),
    input.budget === undefined
      ? current.budget && Object.keys(current.budget).length > 0
        ? JSON.stringify(current.budget)
        : null
      : input.budget && Object.keys(input.budget).length > 0
        ? JSON.stringify(input.budget)
        : null,
    input.quota === undefined
      ? current.quota && Object.keys(current.quota).length > 0
        ? JSON.stringify(current.quota)
        : null
      : input.quota && Object.keys(input.quota).length > 0
        ? JSON.stringify(input.quota)
        : null,
    input.alertThreshold === undefined ? current.alert_threshold : input.alertThreshold,
    input.autoBlock === undefined ? current.auto_block : input.autoBlock ? 1 : 0,
    jsonOrSel(input.ipWhitelist, current.ip_whitelist),
    jsonOrSel(input.ipBlacklist, current.ip_blacklist),
    input.strictIp === undefined ? current.strict_ip : input.strictIp ? 1 : 0,
    input.accessHours === undefined
      ? current.access_hours && Object.keys(current.access_hours).length > 0
        ? JSON.stringify(current.access_hours)
        : null
      : input.accessHours && Object.keys(input.accessHours).length > 0
        ? JSON.stringify(input.accessHours)
        : null,
    input.expiresAt === undefined ? current.expires_at : input.expiresAt,
    input.rotationIntervalDays === undefined
      ? current.rotation_interval_days
      : input.rotationIntervalDays,
    input.gracePeriodDays === undefined ? current.grace_period_days : input.gracePeriodDays,
    input.webhookUrl === undefined
      ? current.webhook_url
      : input.webhookUrl?.trim() || null,
    jsonOrSel(input.scopes, current.scopes),
    id,
  );
}

export function deleteClientKey(id: number): void {
  query("DELETE FROM client_api_keys WHERE id = ?").run(id);
}

export type ResolveResult =
  | { ok: true; key: ClientKey; usedPrevious?: boolean }
  | { ok: false; status: number; message: string };

function rowToResolve(row: ClientKeyRow, usedPrevious: boolean): ResolveResult {
  return { ok: true, key: toClientKey(row), usedPrevious };
}

export function resolveClientKey(token: string | null | undefined): ResolveResult {
  if (!token) {
    return { ok: false, status: 401, message: "api key required" };
  }
  const hash = hashKey(token);
  const row = query(
    `SELECT ${COLUMNS} FROM client_api_keys WHERE key_hash = ?`,
  ).get(hash) as ClientKeyRow | undefined;
  if (row) {
    if (row.is_active !== 1 || row.blocked_at) {
      return { ok: false, status: 401, message: "invalid api key" };
    }
    return rowToResolve(row, false);
  }

  // Grace period setelah rotation: key lama masih valid sampai previous_expires_at.
  const prev = query(
    `SELECT ${COLUMNS} FROM client_api_keys
     WHERE previous_key_hash = ? AND previous_expires_at > unixepoch()`,
  ).get(hash) as ClientKeyRow | undefined;
  if (prev) {
    if (prev.is_active !== 1 || prev.blocked_at) {
      return { ok: false, status: 401, message: "invalid api key" };
    }
    return rowToResolve(prev, true);
  }

  return { ok: false, status: 401, message: "invalid api key" };
}

export function modelAllowed(key: ClientKey, model: string): boolean {
  if (!key.allowed_models || key.allowed_models.length === 0) return true;
  return key.allowed_models.some((prefix) => model.startsWith(prefix));
}

export function modelBlocked(key: ClientKey, model: string): boolean {
  if (!key.blocked_models || key.blocked_models.length === 0) return false;
  return key.blocked_models.some((prefix) => model.startsWith(prefix));
}

export function providerAllowed(key: ClientKey, providerId: string): boolean {
  if (!key.allowed_providers || key.allowed_providers.length === 0) return true;
  return key.allowed_providers.some((p) => p === "*" || p === providerId);
}

export function providerBlocked(key: ClientKey, providerId: string): boolean {
  if (!key.blocked_providers || key.blocked_providers.length === 0) return false;
  return key.blocked_providers.some((p) => p === "*" || p === providerId);
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

/** Backwards-compat: rewrote the "rules" columns only. Empty input clears optional rules. */
export function updateClientKeyRules(
  id: number,
  input: {
    name?: string;
    allowedModels?: string[] | null;
    modelOverride?: string | null;
    pinnedProviderId?: string | null;
  },
): void {
  updateClientKey(id, {
    name: input.name,
    allowedModels: input.allowedModels ?? null,
    modelOverride: input.modelOverride ?? null,
    pinnedProviderId: input.pinnedProviderId ?? null,
  });
}