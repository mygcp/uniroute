import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resetTestDb } from "./test-db";
import type { CreateClientKeyInput } from "./client-key";

process.env.DATABASE_URL = `/tmp/uniroute-key-ops-test-${randomUUID()}.db`;
process.env.API_KEY_SECRET = "deadbeef".repeat(8);

type KeyOpsModule = typeof import("./key-ops");
type ClientKeyModule = typeof import("./client-key");
let ops: KeyOpsModule;
let ck: ClientKeyModule;

beforeAll(async () => {
  await resetTestDb();
  ops = await import("./key-ops");
  ck = await import("./client-key");
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

function makeKey(extra: Partial<CreateClientKeyInput> = {}) {
  return ck.createClientKey({ name: "ops-test", ...extra });
}

describe("key ops", () => {
  beforeEach(() => {
    for (const k of ck.listClientKeys()) ck.deleteClientKey(k.id);
  });

  test("rotateKey returns a new key; old key works during grace via previous slot", () => {
    const { key, id } = makeKey({ gracePeriodDays: 7 });
    const rotated = ops.rotateKey(id);
    expect(rotated.key).not.toBe(key);
    expect(rotated.id).toBe(id);

    const oldResolved = ck.resolveClientKey(key);
    expect(oldResolved.ok).toBe(true);
    if (oldResolved.ok) expect(oldResolved.usedPrevious).toBe(true);

    const newResolved = ck.resolveClientKey(rotated.key);
    expect(newResolved.ok).toBe(true);
    if (newResolved.ok) expect(newResolved.usedPrevious).toBe(false);
  });

  test("rotateKey with grace 0 immediately invalidates old key", () => {
    const { key, id } = makeKey({ gracePeriodDays: 0 });
    ops.rotateKey(id);
    expect(ck.resolveClientKey(key).ok).toBe(false);
  });

  test("suspendKey blocks and reactivateKey unblocks", () => {
    const { key, id } = makeKey();
    expect(ck.resolveClientKey(key).ok).toBe(true);
    ops.suspendKey(id);
    expect(ck.resolveClientKey(key).ok).toBe(false);
    ops.reactivateKey(id);
    expect(ck.resolveClientKey(key).ok).toBe(true);
  });

  test("deleteKey removes the key and table rows", () => {
    const { id } = makeKey();
    ops.deleteKey(id);
    expect(ck.getClientKeyById(id)).toBeUndefined();
  });

  test("autoBlockKey blocks and writes audit", async () => {
    const { key, id } = makeKey({ autoBlock: true });
    ops.autoBlockKey(id, "budget exceeded");
    expect(ck.resolveClientKey(key).ok).toBe(false);
    const auditModule = await import("./key-audit");
    const actions = auditModule.listAudit(id).map((a) => a.action);
    expect(actions).toContain("BUDGET_BLOCKED");
  });

  test("maybeRotateForInterval rotates only when interval elapsed", async () => {
    const { key, id } = makeKey({ rotationIntervalDays: 1, gracePeriodDays: 7 });
    const oldHash = ck.hashKey(key);
    const db = await import("./db");
    db.query("UPDATE client_api_keys SET created_at = unixepoch() - 100000 WHERE id = ?").run(id);
    ops.maybeRotateForInterval(ck.getClientKeyById(id)!);
    expect(ck.getClientKeyById(id)!.key_hash).not.toBe(oldHash);
  });

  test("recordRequestUsage accumulates usage and audits REQUEST", async () => {
    const { id } = makeKey({});
    ops.recordRequestUsage(id, {
      model: "gpt-4o",
      providerId: "openai",
      status: 200,
      promptTokens: 1000,
      completionTokens: 500,
    });
    const usageModule = await import("./key-usage");
    const today = usageModule.usageToday(id);
    expect(today.requests).toBe(1);
    expect(today.promptTokens).toBe(1000);
    expect(today.completionTokens).toBe(500);
    expect(today.cost).toBeCloseTo(0.0075, 5);

    const auditModule = await import("./key-audit");
    const last = auditModule.listAudit(id, 1)[0];
    expect(last.action).toBe("REQUEST");
    expect(last.status).toBe(200);
  });

  test("recordRequestUsage auto-blocks when monthly budget exhausted", () => {
    const { id } = makeKey({ budget: { monthly: 0.001 }, autoBlock: true });
    expect(ck.getClientKeyById(id)!.blocked_at).toBeNull();
    ops.recordRequestUsage(id, {
      model: "gpt-4o",
      providerId: "openai",
      status: 200,
      promptTokens: 1000,
      completionTokens: 0,
    });
    const after = ck.getClientKeyById(id)!;
    expect(after.blocked_at).not.toBeNull();
  });

  test("recordRequestUsage enqueues webhook when budget exhausted", async () => {
    const { id } = makeKey({ budget: { monthly: 0.001 }, webhookUrl: "https://x.example/hook" });
    ops.recordRequestUsage(id, {
      model: "gpt-4o",
      providerId: "openai",
      status: 200,
      promptTokens: 1000,
      completionTokens: 0,
    });
    const wm = await import("./webhook");
    expect(wm.pendingCount()).toBeGreaterThan(0);
  });

  test("healthCheck reports status and metrics", () => {
    const { id } = makeKey({ budget: { monthly: 100 }, alertThreshold: 0.8 });
    ops.recordRequestUsage(id, {
      model: "gpt-4o",
      providerId: "openai",
      status: 200,
      promptTokens: 100,
      completionTokens: 50,
    });
    const h = ops.healthCheck(id);
    expect(h.key_id).toBe(id);
    expect(h.status).toBe("active");
    expect(h.checks.monthly_cost).toBeGreaterThan(0);
  });

  test("deleteKey with child rows does not throw (cleanup paths)", () => {
    const { id } = makeKey({ budget: { monthly: 1 } });
    ops.recordRequestUsage(id, {
      model: "gpt-4o",
      providerId: "openai",
      status: 200,
      promptTokens: 10,
      completionTokens: 5,
    });
    expect(() => ops.deleteKey(id)).not.toThrow();
  });
});