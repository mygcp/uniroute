import type { ClientKey } from "./client-key";
import {
  modelAllowed,
  modelBlocked,
  providerAllowed,
  providerBlocked,
} from "./client-key";
import { isWithinAccessHours } from "./time-access";
import { ipInList } from "./net";
import { checkRateLimit, acquireSlot, releaseSlot } from "./rate-limiter";
import {
  usageThisMonth,
  usageToday,
  type UsageSummary,
} from "./key-usage";
import { checkGroupSharedQuota } from "./key-groups";

export type CheckResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

export type KeyStatus = "active" | "near_limit" | "suspended" | "expired";

export function computeStatus(key: ClientKey, usage: UsageSummary): KeyStatus {
  const now = Math.floor(Date.now() / 1000);
  if (key.expires_at != null && key.expires_at < now) return "expired";
  if (key.blocked_at != null || key.is_active !== 1) return "suspended";
  if (key.alert_threshold != null && key.budget) {
    const monthly = key.budget.monthly;
    if (monthly != null && monthly > 0 && usage.cost / monthly >= key.alert_threshold) {
      return "near_limit";
    }
  }
  return "active";
}

export function isKeyExpired(key: ClientKey, nowMs: number = Date.now()): boolean {
  return key.expires_at != null && key.expires_at * 1000 < nowMs;
}

export function isKeyBlocked(key: ClientKey): boolean {
  return key.blocked_at != null || key.is_active !== 1;
}

/** Ambil IP klien dari header, dengan X-Forwarded-For & CF. */
export function clientIpFromRequest(request: Request): string | null {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const forwarder = request.headers.get("x-forwarded-for");
  if (forwarder) {
    const first = forwarder.split(",")[0]?.trim();
    if (first) return first;
  }
  const direct = request.headers.get("x-real-ip");
  return direct?.trim() || null;
}

export function checkIp(key: ClientKey, ip: string | null): CheckResult {
  if (!ip) return key.strict_ip === 1 ? { ok: false, status: 403, error: "ip not allowed" } : { ok: true };
  if (key.ip_blacklist && ipInList(ip, key.ip_blacklist)) {
    return { ok: false, status: 403, error: "ip blacklisted" };
  }
  if (key.strict_ip === 1) {
    if (!key.ip_whitelist || !ipInList(ip, key.ip_whitelist)) {
      return { ok: false, status: 403, error: "ip not allowed" };
    }
  }
  return { ok: true };
}

export function checkAccessHours(key: ClientKey, now: Date = new Date()): CheckResult {
  const result = isWithinAccessHours(key.access_hours, now);
  if (!result.allowed) {
    return { ok: false, status: 403, error: result.reason ?? "outside allowed hours" };
  }
  return { ok: true };
}

export type BudgetQuotaCheck = {
  ok: boolean;
  reason?: string;
  monthlyUsed?: number;
  monthlyBudget?: number;
};

/**
 * Cek budget & quota berbasis usage terakumulasi (hari & bulan). Tidak
 * menghitung per-request (tidak diketahui di pre-check); per_request dicek
 * setelah request jika tersedia.
 */
export function checkBudgetQuota(key: ClientKey): BudgetQuotaCheck {
  const now = Math.floor(Date.now() / 1000);
  if (key.budget) {
    if (key.budget.monthly != null && key.budget.monthly > 0) {
      const u = usageThisMonth(key.id);
      if (u.cost >= key.budget.monthly) return { ok: false, reason: "budget exceeded" };
    }
    if (key.budget.daily != null && key.budget.daily > 0) {
      const u = usageToday(key.id);
      if (u.cost >= key.budget.daily) return { ok: false, reason: "daily budget exceeded" };
    }
  }
  if (key.quota) {
    if (key.quota.tokens_per_month != null && key.quota.tokens_per_month > 0) {
      const u = usageThisMonth(key.id);
      if (u.promptTokens + u.completionTokens >= key.quota.tokens_per_month) {
        return { ok: false, reason: "token quota exceeded" };
      }
    }
    if (key.quota.requests_per_day != null && key.quota.requests_per_day > 0) {
      const u = usageToday(key.id);
      if (u.requests >= key.quota.requests_per_day) {
        return { ok: false, reason: "request quota exceeded" };
      }
    }
  }
  void now;
  return { ok: true };
}

/** Cek shared quota grup tempat key berada. */
export function checkGroups(key: ClientKey): CheckResult {
  const groupCheck = checkGroupSharedQuota(key);
  if (!groupCheck.ok) return { ok: false, status: 429, error: groupCheck.reason };
  return { ok: true };
}

/** Cek model & provider terhadap daftar allow/block granular. */
export function checkModelProviders(
  key: ClientKey,
  model: string,
  providerId: string | null,
): CheckResult {
  if (!modelAllowed(key, model)) return { ok: false, status: 403, error: "model not allowed" };
  if (modelBlocked(key, model)) return { ok: false, status: 403, error: "model blocked" };
  if (providerId) {
    if (!providerAllowed(key, providerId)) {
      return { ok: false, status: 403, error: "provider not allowed" };
    }
    if (providerBlocked(key, providerId)) {
      return { ok: false, status: 403, error: "provider blocked" };
    }
  }
  return { ok: true };
}

export type RateCheck = {
  allowed: boolean;
  limit?: "rpm" | "tpm";
  scope: string;
};

export function checkRate(key: ClientKey, estimatedTokens: number): RateCheck {
  const scope = `key-${key.id}`;
  const res = checkRateLimit(scope, estimatedTokens, {
    rpm: key.quota?.rpm,
    tpm: key.quota?.tpm,
  });
  return { ...res, scope };
}

export function acquireConcurrency(key: ClientKey): { ok: boolean; scope: string } {
  const scope = `key-concurrency-${key.id}`;
  const limit = key.quota?.concurrent_requests ?? 0;
  if (limit <= 0) return { ok: true, scope };
  return { ok: acquireSlot(scope, limit), scope };
}

export function releaseConcurrency(key: ClientKey, scope: string): void {
  if (!scope) {
    const fallback = `key-concurrency-${key.id}`;
    releaseSlot(fallback);
    return;
  }
  releaseSlot(scope);
}