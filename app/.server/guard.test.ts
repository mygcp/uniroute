import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = `/tmp/uniroute-guard-test-${randomUUID()}.db`;

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
let checkAllowlist: (model: string) => { ok: true } | { ok: false; reason: string };
let seed: () => void;

beforeAll(async () => {
  const db = await import("./db");
  db.resetDb();
  const guard = await import("./guard");
  seed = db.seed;
  checkAllowlist = guard.checkAllowlist;
  seed();
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

describe("guard", () => {
  test("denies a denylisted model", () => {
    const result = checkAllowlist("nonexistent-model");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  test("allows a normal model", () => {
    const result = checkAllowlist("gpt-4o");
    expect(result.ok).toBe(true);
  });

  test("allows unknown non-denied models (permissive default)", () => {
    const result = checkAllowlist("totally-unknown-model-x");
    expect(result.ok).toBe(true);
  });
});
