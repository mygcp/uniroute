import { exec, getTableVersion, onDbReset, onShutdownFlush, query } from "./db";
import type { Provider } from "./registry";

export type HealthState = { ok: boolean; checkedAt: number };

export type BalanceStrategyConfig = {
  strategy: string;
  fallbackEnabled: boolean;
  healthCheck: {
    enabled: boolean;
    url?: string;
    interval: number;
  };
};

const healthCache = new Map<string, HealthState>();
const strategyCache = new Map<string, BalanceStrategyConfig>();
const lastUsedAt = new Map<string, number>();
const activeConns = new Map<string, number>();
const dirtyLastUsed = new Map<string, number>();

let strategyVersion = -1;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

onDbReset(() => {
  strategyVersion = -1;
  strategyCache.clear();
  healthCache.clear();
  lastUsedAt.clear();
  activeConns.clear();
  dirtyLastUsed.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
});

export function flushBalancerStats(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (dirtyLastUsed.size === 0) return;
  const entries = [...dirtyLastUsed.entries()];
  dirtyLastUsed.clear();
  try {
    exec("BEGIN");
    try {
      const stmt = query("UPDATE providers SET last_used_at = ? WHERE id = ?");
      for (const [id, ts] of entries) {
        stmt.run(ts, id);
      }
      exec("COMMIT");
    } catch {
      exec("ROLLBACK");
    }
  } catch {
    /* ignore */
  }
}

onShutdownFlush(flushBalancerStats);

export function getStrategy(model: string): BalanceStrategyConfig {
  const ver = getTableVersion("load_balancing");
  if (ver !== strategyVersion) {
    strategyCache.clear();
    strategyVersion = ver;
  }
  const cached = strategyCache.get(model);
  if (cached) return cached;

  const row = query("SELECT * FROM load_balancing WHERE model_name = ?").get(
    model,
  ) as
    | {
        strategy: string;
        fallback_enabled: number;
        health_check_enabled: number;
        health_check_url: string | null;
        health_check_interval: number;
      }
    | undefined;

  const cfg: BalanceStrategyConfig = !row
    ? {
        strategy: "round_robin",
        fallbackEnabled: true,
        healthCheck: { enabled: false, interval: 60 },
      }
    : {
        strategy: row.strategy,
        fallbackEnabled: !!row.fallback_enabled,
        healthCheck: {
          enabled: !!row.health_check_enabled,
          url: row.health_check_url ?? undefined,
          interval: row.health_check_interval ?? 60,
        },
      };
  strategyCache.set(model, cfg);
  return cfg;
}

function effectiveLastUsed(p: Provider): number {
  return Math.max(p.last_used_at, lastUsedAt.get(p.id) ?? 0);
}

function effectiveConns(p: Provider): number {
  return activeConns.get(p.id) ?? p.current_connections;
}

function roundRobin(pool: Provider[]): Provider | undefined {
  let best = pool[0];
  let bestTs = best ? effectiveLastUsed(best) : 0;
  for (let i = 1; i < pool.length; i++) {
    const p = pool[i];
    const ts = effectiveLastUsed(p);
    if (ts < bestTs) {
      best = p;
      bestTs = ts;
    }
  }
  return best;
}

function randomPick(pool: Provider[]): Provider | undefined {
  if (pool.length === 0) return undefined;
  return pool[Math.floor(Math.random() * pool.length)];
}

function priorityPick(pool: Provider[]): Provider | undefined {
  let best = pool[0];
  for (let i = 1; i < pool.length; i++) {
    if (pool[i].priority > best.priority) best = pool[i];
  }
  return best;
}

function weightedPick(pool: Provider[]): Provider | undefined {
  if (pool.length === 0) return undefined;
  let total = 0;
  for (const p of pool) total += Math.max(1, p.weight);
  let roll = Math.random() * total;
  for (const p of pool) {
    roll -= Math.max(1, p.weight);
    if (roll < 0) return p;
  }
  return pool[pool.length - 1];
}

function leastConn(pool: Provider[]): Provider | undefined {
  let best = pool[0];
  let bestC = best ? effectiveConns(best) : 0;
  for (let i = 1; i < pool.length; i++) {
    const p = pool[i];
    const c = effectiveConns(p);
    if (c < bestC) {
      best = p;
      bestC = c;
    }
  }
  return best;
}

export function getHealth(providerId: string): HealthState | undefined {
  return healthCache.get(providerId);
}

export function setHealth(providerId: string, ok: boolean): void {
  healthCache.set(providerId, { ok, checkedAt: Date.now() });
}

function firstAvailable(
  pool: Provider[],
  health: BalanceStrategyConfig["healthCheck"],
): Provider | undefined {
  if (!health.enabled) {
    return pool[0];
  }
  for (const p of pool) {
    const state = healthCache.get(p.id);
    if (!state || state.ok) return p;
  }
  return undefined;
}

export function selectProvider(
  pool: Provider[],
  model: string,
  config?: BalanceStrategyConfig,
): Provider | undefined {
  if (pool.length === 0) return undefined;
  const cfg = config ?? getStrategy(model);
  switch (cfg.strategy) {
    case "random":
      return randomPick(pool);
    case "priority":
      return priorityPick(pool);
    case "weighted":
      return weightedPick(pool);
    case "least_conn":
      return leastConn(pool);
    case "first_available":
      return firstAvailable(pool, cfg.healthCheck);
    case "round_robin":
    default:
      return roundRobin(pool);
  }
}

export function markUsed(provider: Provider): void {
  const now = Date.now();
  lastUsedAt.set(provider.id, now);
  dirtyLastUsed.set(provider.id, now);
  if (!flushTimer) {
    flushTimer = setTimeout(flushBalancerStats, 5000);
    flushTimer.unref?.();
  }
}

export function beginConnection(providerId: string): void {
  activeConns.set(providerId, (activeConns.get(providerId) ?? 0) + 1);
  query(
    `UPDATE providers SET current_connections = current_connections + 1 WHERE id = ?`,
  ).run(providerId);
}

export function endConnection(providerId: string): void {
  const cur = activeConns.get(providerId) ?? 0;
  activeConns.set(providerId, cur > 0 ? cur - 1 : 0);
  query(
    `UPDATE providers SET current_connections = MAX(0, current_connections - 1) WHERE id = ?`,
  ).run(providerId);
}
