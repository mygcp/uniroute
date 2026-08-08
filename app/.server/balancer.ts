import { query } from "./db";
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

export function getStrategy(model: string): BalanceStrategyConfig {
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

  if (!row) {
    return {
      strategy: "round_robin",
      fallbackEnabled: true,
      healthCheck: { enabled: false, interval: 60 },
    };
  }
  return {
    strategy: row.strategy,
    fallbackEnabled: !!row.fallback_enabled,
    healthCheck: {
      enabled: !!row.health_check_enabled,
      url: row.health_check_url ?? undefined,
      interval: row.health_check_interval ?? 60,
    },
  };
}

function roundRobin(pool: Provider[]): Provider | undefined {
  return [...pool].sort((a, b) => a.last_used_at - b.last_used_at)[0];
}

function randomPick(pool: Provider[]): Provider | undefined {
  if (pool.length === 0) return undefined;
  return pool[Math.floor(Math.random() * pool.length)];
}

function priorityPick(pool: Provider[]): Provider | undefined {
  return [...pool].sort((a, b) => b.priority - a.priority)[0];
}

function weightedPick(pool: Provider[]): Provider | undefined {
  if (pool.length === 0) return undefined;
  const total = pool.reduce((sum, p) => sum + Math.max(1, p.weight), 0);
  let roll = Math.random() * total;
  for (const p of pool) {
    roll -= Math.max(1, p.weight);
    if (roll < 0) return p;
  }
  return pool[pool.length - 1];
}

function leastConn(pool: Provider[]): Provider | undefined {
  return [...pool].sort(
    (a, b) => a.current_connections - b.current_connections,
  )[0];
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
  // Semua provider unhealthy — pilih yang terakhir dicek paling lama untuk
  // memberi kesempatan reconnect (fallback behavior).
  return undefined;
}

export function selectProvider(
  pool: Provider[],
  model: string,
): Provider | undefined {
  if (pool.length === 0) return undefined;
  const cfg = getStrategy(model);
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
  query(
    `UPDATE providers SET last_used_at =
       (CAST(strftime('%s','now') AS INTEGER) * 1000) +
       CAST(substr(strftime('%f','now'), 4) AS INTEGER)
     WHERE id = ?`,
  ).run(provider.id);
}

export function beginConnection(providerId: string): void {
  query(
    `UPDATE providers SET current_connections = current_connections + 1 WHERE id = ?`,
  ).run(providerId);
}

export function endConnection(providerId: string): void {
  query(
    `UPDATE providers SET current_connections = MAX(0, current_connections - 1) WHERE id = ?`,
  ).run(providerId);
}