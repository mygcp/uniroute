import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = `/tmp/uniroute-registry-test-${randomUUID()}.db`;

type RegModule = typeof import("./registry");
type DbModule = typeof import("./db");
let reg: RegModule;
let db: DbModule;

beforeAll(async () => {
  db = await import("./db");
  db.resetDb();
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

  test("opencode is seeded as a free provider and maps its models", () => {
    db.seed();
    db.query("UPDATE providers SET is_active = 1 WHERE id = 'opencode'").run();
    reg.reload();
    expect(reg.getAnyProvider("big-pickle").length).toBe(1);
    const direct = reg.getProviders("big-pickle");
    expect(direct.length).toBe(1);
    expect(direct[0].id).toBe("opencode");
    expect(direct[0].base_url).toBe("https://opencode.ai/zen/v1");
    expect(direct[0].auth_type).toBe("none");
    db.query("UPDATE providers SET is_active = 0 WHERE id = 'opencode'").run();
    reg.reload();
  });

  test("opencode model list matches live Zen free models", () => {
    const rows = db.query(
      "SELECT model_name, is_active FROM models WHERE provider_id = 'opencode' ORDER BY model_name",
    ).all() as unknown as { model_name: string; is_active: number }[];
    expect(rows.map((r) => r.model_name)).toEqual([
      "big-pickle",
      "deepseek-v4-flash-free",
      "laguna-s-2.1-free",
      "ling-3.0-flash-free",
      "ling-3.0-tiny-free",
      "longcat-2.0-free",
      "mimo-v2.5-free",
      "nemotron-3-ultra-free",
      "north-mini-code-free",
    ]);
    expect(rows.every((r) => r.is_active === 1)).toBe(true);
  });

  test("ensureOpenCodeProvider deactivates legacy hy3-free model", () => {
    db.query(
      "INSERT INTO models (model_name, provider_id, context_length, is_active, is_primary) VALUES ('hy3-free', 'opencode', 131000, 1, 0)",
    ).run();
    db.ensureOpenCodeProvider();
    const hy3 = db.query(
      "SELECT is_active FROM models WHERE model_name = 'hy3-free' AND provider_id = 'opencode'",
    ).get() as { is_active: number };
    expect(hy3.is_active).toBe(0);
    db.query("DELETE FROM models WHERE model_name = 'hy3-free'").run();
  });

  test("dahl is seeded as a Bearer provider and maps its models", () => {
    db.seed();
    db.ensureDahlProvider();
    db.query("UPDATE providers SET is_active = 1 WHERE id = 'dahl'").run();
    reg.reload();
    expect(reg.getProviders("moonshotai/Kimi-K2.6").length).toBe(1);
    const direct = reg.getProviders("MiniMaxAI/MiniMax-M2.7");
    expect(direct.length).toBe(1);
    expect(direct[0].id).toBe("dahl");
    expect(direct[0].base_url).toBe("https://inference.dahl.global/v1");
    expect(direct[0].auth_type).toBe("bearer");
    db.query("UPDATE providers SET is_active = 0 WHERE id = 'dahl'").run();
    reg.reload();
  });

  test("dahl model list matches live models", () => {
    const rows = db.query(
      "SELECT model_name FROM models WHERE provider_id = 'dahl' ORDER BY model_name",
    ).all() as unknown as { model_name: string }[];
    expect(rows.map((r) => r.model_name)).toEqual([
      "MiniMaxAI/MiniMax-M2.7",
      "moonshotai/Kimi-K2.6",
    ]);
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