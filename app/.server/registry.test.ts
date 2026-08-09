import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = `/tmp/uniroute-registry-test-${randomUUID()}.db`;

type RegModule = typeof import("./registry");
type DbModule = typeof import("./db");
let reg: RegModule;
let db: DbModule;

beforeAll(async () => {
  db = await import("./db");
  reg = await import("./registry");
  db.seed();
  for (const id of ["openai", "groq", "openrouter", "anthropic"]) {
    db.query("UPDATE providers SET is_active = 1 WHERE id = ?").run(id);
  }
  reg.reload();
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

describe("registry", () => {
  test("gpt-4o maps to 3 active providers", () => {
    reg.reload();
    const providers = reg.getProviders("gpt-4o");
    expect(providers.length).toBe(3);
    const ids = providers.map((p) => p.id).sort();
    expect(ids).toEqual(["groq", "openai", "openrouter"]);
  });

  test("claude-3-5-sonnet maps to anthropic", () => {
    reg.reload();
    const providers = reg.getProviders("claude-3-5-sonnet");
    expect(providers.length).toBe(1);
    expect(providers[0].id).toBe("anthropic");
  });

  test("unknown model returns empty list", () => {
    reg.reload();
    expect(reg.getProviders("no-such-model")).toEqual([]);
  });

  test("opencode is seeded as a provider and maps its models", () => {
    db.seed();
    db.query("UPDATE providers SET is_active = 1 WHERE id = 'opencode'").run();
    reg.reload();
    expect(reg.getAnyProvider("big-pickle").length).toBe(1);
    const direct = reg.getProviders("big-pickle");
    expect(direct.length).toBe(1);
    expect(direct[0].id).toBe("opencode");
    expect(direct[0].base_url).toBe("https://opencode.ai/zen/v1");
    db.query("UPDATE providers SET is_active = 0 WHERE id = 'opencode'").run();
    reg.reload();
  });

  test("inactive provider is filtered out after reload", () => {
    reg.reload();
    const testProvider = "__reg_test_inactive__";
    const testModel = "__reg_test_inactive__";
    db.exec("BEGIN");
    try {
      db.query(
        `INSERT INTO providers (id, name, base_url, auth_type, is_active)
         VALUES (?, ?, ?, 'bearer', 0)`,
      ).run(testProvider, testProvider, "http://x");
      db.query(
        `INSERT INTO models (model_name, provider_id, is_active, is_primary)
         VALUES (?, ?, 1, 1)`,
      ).run(testModel, testProvider);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    reg.reload();
    expect(reg.getProviders(testModel)).toEqual([]);
    expect(reg.getAnyProvider("gpt-4o").length).toBeGreaterThanOrEqual(3);

    db.query("DELETE FROM models WHERE model_name = ?").run(testModel);
    db.query("DELETE FROM providers WHERE id = ?").run(testProvider);
    reg.reload();
  });
});