import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resetTestDb } from "./test-db";
import type { CreateClientKeyInput } from "./client-key";

process.env.DATABASE_URL = `/tmp/uniroute-enforce-test-${randomUUID()}.db`;

type EnforceModule = typeof import("./key-enforce");
type ClientKeyModule = typeof import("./client-key");
let ef: EnforceModule;
let ck: ClientKeyModule;

beforeAll(async () => {
  await resetTestDb();
  ef = await import("./key-enforce");
  ck = await import("./client-key");
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

function resolve(extra: Partial<CreateClientKeyInput> = {}) {
  const { key } = ck.createClientKey({ name: "enforce", ...extra });
  const r = ck.resolveClientKey(key);
  if (!r.ok) throw new Error("resolve failed");
  return r.key;
}

describe("enforce: status & basic checks", () => {
  test("computeStatus: active, expired, suspended, near_limit", () => {
    const active = resolve({});
    expect(ef.computeStatus(active, { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 })).toBe("active");

    const expired = resolve({ expiresAt: Math.floor(Date.now() / 1000) - 10 });
    expect(ef.computeStatus(expired, { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 })).toBe("expired");

    const suspended = resolve({});
    ck.setClientKeyBlocked(suspended.id, Math.floor(Date.now() / 1000));
    const s = ck.getClientKeyById(suspended.id)!;
    expect(ef.computeStatus(s, { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 })).toBe("suspended");

    const near = resolve({ budget: { monthly: 100 }, alertThreshold: 0.8 });
    expect(ef.computeStatus(near, { requests: 0, promptTokens: 0, completionTokens: 0, cost: 85 })).toBe("near_limit");
  });

  test("checkIp: blacklist denies, strict whitelist only", () => {
    const blacklisted = resolve({ ipBlacklist: ["192.168.1.5"] });
    expect(ef.checkIp(blacklisted, "192.168.1.5").ok).toBe(false);
    expect(ef.checkIp(blacklisted, "10.0.0.1").ok).toBe(true);

    const strict = resolve({ ipWhitelist: ["10.0.0.0/8"], strictIp: true });
    expect(ef.checkIp(strict, "10.1.2.3").ok).toBe(true);
    expect(ef.checkIp(strict, "11.0.0.1").ok).toBe(false);
    expect(ef.checkIp(strict, null).ok).toBe(false);
  });

  test("checkAccessHours uses configured window", () => {
    const cfg = { enabled: true, timezone: "UTC", start_time: "08:00", end_time: "18:00" };
    const key = resolve({ accessHours: cfg });
    expect(ef.checkAccessHours(key, new Date("2026-08-07T09:00:00Z")).ok).toBe(true);
    expect(ef.checkAccessHours(key, new Date("2026-08-07T20:00:00Z")).ok).toBe(false);
  });

  test("checkModelProviders: blocked model & provider allowed/blocked", () => {
    const key = resolve({ blockedModels: ["llama-"], allowedProviders: ["openai"], blockedProviders: ["deepseek"] });
    expect(ef.checkModelProviders(key, "llama-3-8b", "openai").ok).toBe(false);
    expect(ef.checkModelProviders(key, "gpt-4o", "openai").ok).toBe(true);
    expect(ef.checkModelProviders(key, "gpt-4o", "anthropic").ok).toBe(false);
    expect(ef.checkModelProviders(key, "gpt-4o", "deepseek").ok).toBe(false);
  });
});

describe("enforce: budget & quota", () => {
  test("checkBudgetQuota enforces monthly budget from usage", async () => {
    const key = resolve({ budget: { monthly: 10 } });
    const db = await import("./db");
    const today = new Date().toISOString().slice(0, 10);
    db.query("INSERT INTO key_usage_daily (key_id, date, requests, cost) VALUES (?, ?, 1, 12)")
      .run(key.id, today);
    const res = ef.checkBudgetQuota(key);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("budget exceeded");
  });

  test("checkBudgetQuota enforces token quota", async () => {
    const key = resolve({ quota: { tokens_per_month: 100 } });
    const db = await import("./db");
    const today = new Date().toISOString().slice(0, 10);
    db.query("INSERT INTO key_usage_daily (key_id, date, prompt_tokens, completion_tokens) VALUES (?, ?, 60, 60)")
      .run(key.id, today);
    const res = ef.checkBudgetQuota(key);
    expect(res.ok).toBe(false);
  });

  test("checkRate enforces rpm", () => {
    const key = resolve({ quota: { rpm: 2 } });
    expect(ef.checkRate(key, 0).allowed).toBe(true);
    expect(ef.checkRate(key, 0).allowed).toBe(true);
    expect(ef.checkRate(key, 0).allowed).toBe(false);
  });

  test("acquireConcurrency/releaseConcurrency enforce limit", () => {
    const key = resolve({ quota: { concurrent_requests: 2 } });
    const a = ef.acquireConcurrency(key);
    const b = ef.acquireConcurrency(key);
    const c = ef.acquireConcurrency(key);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(false);
    ef.releaseConcurrency(key, b.scope);
    const d = ef.acquireConcurrency(key);
    expect(d.ok).toBe(true);
    ef.releaseConcurrency(key, a.scope);
    ef.releaseConcurrency(key, d.scope);
  });
});

describe("enforce: groups", () => {
  test("group shared quota blocks when exceeded", async () => {
    const gm = await import("./key-groups");
    const db = await import("./db");
    const key = resolve({});
    const groupId = gm.createGroup("team-a", null, { monthly_budget: 5 }, [key.id]);
    const today = new Date().toISOString().slice(0, 10);
    db.query("INSERT INTO key_usage_daily (key_id, date, requests, cost) VALUES (?, ?, 1, 8)")
      .run(key.id, today);
    const res = ef.checkGroups(key);
    expect(res.ok).toBe(false);
    gm.deleteGroup(groupId);
  });
});