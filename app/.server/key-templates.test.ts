import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resetTestDb } from "./test-db";

process.env.DATABASE_URL = `/tmp/uniroute-key-templates-test-${randomUUID()}.db`;

type TemplatesModule = typeof import("./key-templates");
let tm: TemplatesModule;

beforeAll(async () => {
  await resetTestDb();
  tm = await import("./key-templates");
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

describe("key templates", () => {
  test("createTemplate/listTemplates/getTemplate roundtrip", () => {
    const id = tm.createTemplate("production-default", "Standard prod config", {
      name: "production-default",
      allowedModels: ["gpt-4o", "claude-3.5"],
      budget: { monthly: 100 },
      quota: { rpm: 100, concurrent_requests: 5 },
    });
    expect(id).toBeGreaterThan(0);
    const list = tm.listTemplates();
    expect(list.some((t) => t.name === "production-default")).toBe(true);
    const got = tm.getTemplate(id)!;
    expect(got.description).toBe("Standard prod config");
    expect(got.config.allowedModels).toEqual(["gpt-4o", "claude-3.5"]);
    expect(got.config.budget).toEqual({ monthly: 100 });
    expect(got.config.quota).toEqual({ rpm: 100, concurrent_requests: 5 });
    tm.deleteTemplate(id);
    expect(tm.getTemplate(id)).toBeUndefined();
  });

  test("deleteTemplate removes only the target", () => {
    const a = tm.createTemplate("t1", null, { name: "t1" });
    const b = tm.createTemplate("t2", null, { name: "t2" });
    tm.deleteTemplate(a);
    expect(tm.getTemplate(a)).toBeUndefined();
    expect(tm.getTemplate(b)).toBeDefined();
    tm.deleteTemplate(b);
  });

  test("malformed config parsing falls back gracefully", async () => {
    const db = await import("./db");
    db.query("INSERT INTO key_templates (name, description, config) VALUES ('bad', NULL, 'not-json')").run();
    const bad = tm.listTemplates().find((t) => t.name === "bad");
    expect(bad).toBeDefined();
    expect(bad!.config).toEqual({ name: "" });
    tm.deleteTemplate(bad!.id);
  });
});