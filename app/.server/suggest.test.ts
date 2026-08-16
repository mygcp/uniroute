import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = `/tmp/uniroute-suggest-test-${randomUUID()}.db`;

type SuggestModule = typeof import("./suggest");
type DbModule = typeof import("./db");

let suggest: SuggestModule;
let db: DbModule;

beforeAll(async () => {
  db = await import("./db");
  db.resetDb();
  suggest = await import("./suggest");
  db.seed();
  db.query("DELETE FROM models;").run();
  db.query(
    "INSERT INTO providers (id, name, base_url, auth_type, is_active, weight, priority) VALUES ('p1', 'Prov A', 'https://x', 'bearer', 1, 1, 0)",
  ).run();
  db.query(
    "INSERT INTO models (model_name, provider_id, context_length, is_active, is_primary) VALUES ('gpt-4o', 'p1', 1000, 1, 0)",
  ).run();
  db.query(
    "INSERT INTO models (model_name, provider_id, context_length, is_active, is_primary) VALUES ('gpt-4o-mini', 'p1', 2000, 1, 0)",
  ).run();
  db.query(
    "INSERT INTO models (model_name, provider_id, context_length, is_active, is_primary) VALUES ('retired-model', 'p1', 2000, 0, 0)",
  ).run();
  db.query(
    "INSERT INTO model_allowlist (model_name, action, reason) VALUES ('legacy-model', 'deny', 'test')",
  ).run();
  db.query(
    `INSERT INTO routing_rules (name, source_model, rule_type, target_model, target_provider_id, priority, is_active)
     VALUES ('r1', 'gpt-4o', 'rewrite', 'claude-3-haiku', NULL, 10, 1)`,
  ).run();
  db.query(
    "INSERT INTO client_api_keys (name, key_hash, key_prefix, allowed_models, model_override, pinned_provider_id, is_active) VALUES ('k1', 'hash1', 'sk-test1', '[\"gpt-4\",\"gpt-4o\"]', 'gpt-4o-mini', NULL, 1)",
  ).run();
  db.query(
    "INSERT INTO combos (name, strategy, config, created_at, updated_at) VALUES ('coding', 'priority', '{}', 0, 0)",
  ).run();
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

describe("getModelSuggestions", () => {
  test("includes active and system-referenced models", () => {
    const result = suggest.getModelSuggestions();
    const expected = [
      "gpt-4o",
      "gpt-4o-mini",
      "legacy-model",
      "claude-3-haiku",
      "gpt-4",
    ];
    for (const m of expected) expect(result).toContain(m);
  });

  test("returns unique, sorted entries", () => {
    const result = suggest.getModelSuggestions();
    expect(new Set(result).size).toBe(result.length);
    expect(result).toEqual([...result].sort((a, b) => a.localeCompare(b)));
  });

  test("excludes inactive models with no other reference", () => {
    expect(suggest.getModelSuggestions()).not.toContain("retired-model");
  });
});

describe("getProviderSuggestions", () => {
  test("returns provider ids, unique and sorted", () => {
    const result = suggest.getProviderSuggestions();
    expect(result).toContain("p1");
    expect(new Set(result).size).toBe(result.length);
    expect(result).toEqual([...result].sort((a, b) => a.localeCompare(b)));
  });
});

describe("getStructuredSuggestions", () => {
  test("active models carry provider", () => {
    const result = suggest.getStructuredSuggestions();
    const gpt4o = result.find((s) => s.value === "gpt-4o");
    expect(gpt4o).toEqual({ value: "gpt-4o", type: "model", provider: "p1" });
  });

  test("allowlist/key models included without provider", () => {
    const result = suggest.getStructuredSuggestions();
    const legacy = result.find((s) => s.value === "legacy-model");
    expect(legacy).toEqual({ value: "legacy-model", type: "model" });
    const gpt4 = result.find((s) => s.value === "gpt-4");
    expect(gpt4).toEqual({ value: "gpt-4", type: "model" });
  });

  test("combos listed as combo:<name> with type combo", () => {
    const result = suggest.getStructuredSuggestions();
    expect(result).toContainEqual({ value: "combo:coding", type: "combo" });
  });

  test("no duplicate values; models sorted before combos", () => {
    const result = suggest.getStructuredSuggestions();
    const values = result.map((s) => s.value);
    expect(new Set(values).size).toBe(values.length);
    const modelValues = result
      .filter((s) => s.type === "model")
      .map((s) => s.value);
    const comboValues = result
      .filter((s) => s.type === "combo")
      .map((s) => s.value);
    expect(modelValues).toEqual([...modelValues].sort((a, b) => a.localeCompare(b)));
    expect(comboValues).toEqual([...comboValues].sort((a, b) => a.localeCompare(b)));
  });
});
