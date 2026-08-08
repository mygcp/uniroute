import { describe, expect, test } from "bun:test";
import { exec, query } from "./db";
import {
  getAnyProvider,
  getProviders,
  reload,
} from "./registry";

describe("registry", () => {
  test("gpt-4o maps to 3 active providers", () => {
    const providers = getProviders("gpt-4o");
    expect(providers.length).toBe(3);
    const ids = providers.map((p) => p.id).sort();
    expect(ids).toEqual(["groq", "openai", "openrouter"]);
  });

  test("claude-3-5-sonnet maps to anthropic", () => {
    const providers = getProviders("claude-3-5-sonnet");
    expect(providers.length).toBe(1);
    expect(providers[0].id).toBe("anthropic");
  });

  test("unknown model returns empty list", () => {
    expect(getProviders("no-such-model")).toEqual([]);
  });

  test("inactive provider is filtered out after reload", () => {
    const testProvider = "__reg_test_inactive__";
    const testModel = "__reg_test_inactive__";
    exec("BEGIN");
    try {
      query(
        `INSERT INTO providers (id, name, base_url, auth_type, is_active)
         VALUES (?, ?, ?, 'bearer', 0)`,
      ).run(testProvider, testProvider, "http://x");
      query(
        `INSERT INTO models (model_name, provider_id, is_active, is_primary)
         VALUES (?, ?, 1, 1)`,
      ).run(testModel, testProvider);
      exec("COMMIT");
    } catch (e) {
      exec("ROLLBACK");
      throw e;
    }

    reload();
    expect(getProviders(testModel)).toEqual([]);
    expect(getAnyProvider("gpt-4o").length).toBeGreaterThanOrEqual(3);

    query("DELETE FROM models WHERE model_name = ?").run(testModel);
    query("DELETE FROM providers WHERE id = ?").run(testProvider);
    reload();
  });
});