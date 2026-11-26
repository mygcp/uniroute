import { query } from "./db";
import {
  getClientKeyById,
  generateKey,
  hashKey,
  setClientKeyBlocked,
  type ClientKey,
} from "./client-key";
import { encryptKey } from "./key-crypto";
import { hasBudgetAlertSince, logAudit, recentAudit } from "./key-audit";
import { usageThisMonth, usageToday, recordUsage, type UsageSummary } from "./key-usage";
import { enqueueWebhook } from "./webhook";
import { estimateCost } from "./pricing";
import { computeStatus } from "./key-enforce";

function fireWebhook(key: ClientKey | undefined, event: string, extra: Record<string, unknown> = {}): void {
  if (!key?.webhook_url) return;
  enqueueWebhook({
    keyId: key.id,
    event,
    url: key.webhook_url,
    payload: { event, key_id: key.id, key_prefix: key.key_prefix, at: Date.now(), ...extra },
  });
}

/**
 * Rotasi: generate key baru; key lama dipindah ke slot previous dan tetap
 * valid selama `grace_period_days` (0 → langsung tidak valid). `created_at`
 * dibarui sebagai penanda waktu rotasi terakhir (dipakai deteksi interval).
 */
export function rotateKey(id: number): { key: string; id: number } {
  const current = getClientKeyById(id);
  if (!current) throw new Error("key not found");

  const graceDays = current.grace_period_days ?? 0;
  const graceUntil =
    graceDays > 0 ? Math.floor(Date.now() / 1000) + graceDays * 86400 : null;
  const newKey = generateKey(current.key_prefix || undefined);
  const newEnc = encryptKey(newKey);

  query(
    `UPDATE client_api_keys SET
       key_hash = ?, key_enc = ?,
       previous_key_hash = ?, previous_key_enc = ?,
       previous_expires_at = ?, created_at = unixepoch()
     WHERE id = ?`,
  ).run(
    hashKey(newKey),
    newEnc,
    graceUntil ? current.key_hash : null,
    graceUntil ? current.key_enc : null,
    graceUntil,
    id,
  );

  logAudit(id, "KEY_ROTATED", {
    details: JSON.stringify({
      previous_key_prefix: current.key_prefix,
      grace_until: graceUntil,
    }),
  });
  fireWebhook(getClientKeyById(id), "rotated", { grace_until: graceUntil });
  return { key: newKey, id };
}

/** Rotasi terjadwal bila interval `rotation_interval_days` sudah terlampaui. */
export function maybeRotateForInterval(key: ClientKey): void {
  const interval = key.rotation_interval_days;
  if (!interval || interval <= 0) return;
  const lastRotated = key.created_at ?? 0;
  if (Math.floor(Date.now() / 1000) - lastRotated >= interval * 86400) {
    rotateKey(key.id);
  }
}

export function suspendKey(id: number, byIp = "dashboard"): void {
  setClientKeyBlocked(id, Math.floor(Date.now() / 1000));
  logAudit(id, "KEY_SUSPENDED", { ip: byIp });
  fireWebhook(getClientKeyById(id), "suspended");
}

export function reactivateKey(id: number, byIp = "dashboard"): void {
  setClientKeyBlocked(id, null);
  logAudit(id, "KEY_REACTIVATED", { ip: byIp });
  fireWebhook(getClientKeyById(id), "reactivated");
}

/** Auto-block saat budget/quota tercapai (dari pipeline request atau operasi). */
export function autoBlockKey(id: number, reason: string): void {
  setClientKeyBlocked(id, Math.floor(Date.now() / 1000));
  logAudit(id, "BUDGET_BLOCKED", {
    details: JSON.stringify({ reason }),
  });
  fireWebhook(getClientKeyById(id), "budget_exceeded", { reason, blocked: true });
}

export function deleteKey(id: number, byIp = "dashboard"): void {
  const key = getClientKeyById(id);
  logAudit(id, "KEY_DELETED", { ip: byIp });
  fireWebhook(key, "deleted");
  query("DELETE FROM client_api_keys WHERE id = ?").run(id);
}

function monthStartSec(): number {
  const now = new Date();
  return Math.floor(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).getTime() / 1000);
}

export type RequestOutcomeInput = {
  model: string;
  providerId: string;
  status: number;
  promptTokens: number;
  completionTokens: number;
  ip?: string | null;
  userAgent?: string | null;
};

/**
 * Dicatat SETELAH request selesai: update usage harian, audit REQUEST,
 * cek alert threshold → webhook, dan auto-block bila budget habis.
 * Return `{ blocked }` agar caller bisa membalas 429 bila perlu.
 */
export function recordRequestUsage(
  keyIdOrKey: number | ClientKey,
  input: RequestOutcomeInput,
): { blocked: boolean } {
  const key = typeof keyIdOrKey === "number" ? getClientKeyById(keyIdOrKey) : keyIdOrKey;
  if (!key) return { blocked: false };
  const keyId = key.id;
  const tokens = input.promptTokens + input.completionTokens;
  const cost = estimateCost(input.model, input.providerId, input.promptTokens, input.completionTokens);

  recordUsage(keyId, {
    requests: 1,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    cost,
  });
  logAudit(keyId, "REQUEST", {
    model: input.model,
    provider_id: input.providerId,
    status: input.status,
    tokens,
    cost,
    ip: input.ip ?? undefined,
    user_agent: input.userAgent ?? undefined,
  });

  const monthlyBudget = key.budget?.monthly;
  let blocked = false;

  if (monthlyBudget != null && monthlyBudget > 0) {
    const month = usageThisMonth(keyId);
    const threshold = key.alert_threshold;
    const hitThreshold =
      threshold != null && threshold > 0 && month.cost >= monthlyBudget * threshold;
    const exhausted = month.cost >= monthlyBudget;
    if (hitThreshold || exhausted) {
      const alerted = hasBudgetAlertSince(keyId, monthStartSec());
      if (!alerted) {
        logAudit(keyId, "BUDGET_ALERT", {
          details: JSON.stringify({ cost: month.cost, budget: monthlyBudget, exhausted }),
        });
        fireWebhook(key, "budget_exceeded", { cost: month.cost, budget: monthlyBudget, exhausted });
      }
    }
    if (key.auto_block === 1 && exhausted) {
      setClientKeyBlocked(keyId, Math.floor(Date.now() / 1000));
      logAudit(keyId, "BUDGET_BLOCKED", {
        details: JSON.stringify({ cost: month.cost, budget: monthlyBudget }),
      });
      fireWebhook(key, "budget_exceeded", {
        cost: month.cost,
        budget: monthlyBudget,
        blocked: true,
      });
      blocked = true;
    }
  }

  return { blocked };
}

export type KeyHealth = {
  key_id: number;
  name: string;
  status: ReturnType<typeof computeStatus>;
  checks: {
    valid: boolean;
    expired: boolean;
    suspended: boolean;
    budget_remaining: number | null;
    monthly_cost: number;
    requests_today: number;
    errors_last_hour: number;
    last_used: number | null;
  };
};

export function healthCheck(
  id: number,
  preloaded?: { key?: ClientKey; month?: UsageSummary; today?: UsageSummary },
): KeyHealth {
  const key = preloaded?.key ?? getClientKeyById(id);
  if (!key) throw new Error("key not found");
  const month: UsageSummary = preloaded?.month ?? usageThisMonth(id);
  const today = preloaded?.today ?? usageToday(id);
  const status = computeStatus(key, month);
  const recent = recentAudit(id, Math.floor(Date.now() / 1000) - 3600);
  const errors = recent.filter((a) => a.action === "REQUEST" && (a.status ?? 0) >= 400).length;
  const lastUsed = query(
    "SELECT MAX(created_at) AS last FROM request_logs WHERE api_key_id = ?",
  ).get(id) as { last: number | null } | undefined;
  return {
    key_id: id,
    name: key.name,
    status,
    checks: {
      valid: status !== "suspended" && status !== "expired",
      expired: status === "expired",
      suspended: status === "suspended",
      budget_remaining:
        key.budget?.monthly != null ? Math.max(0, key.budget.monthly - month.cost) : null,
      monthly_cost: month.cost,
      requests_today: today.requests,
      errors_last_hour: errors,
      last_used: lastUsed?.last ?? null,
    },
  };
}