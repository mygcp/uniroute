import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = `/tmp/uniroute-model-public-test-${randomUUID()}.db`;

type ModelPublicModule = typeof import("./model-public");
type DbModule = typeof import("./db");

let mp: ModelPublicModule;
let db: DbModule;

beforeAll(async () => {
  db = await import("./db");
  db.resetDb();
  mp = await import("./model-public");
  db.seed();
  db.query(
    "INSERT INTO providers (id, name, base_url, auth_type, is_active, weight, priority) VALUES ('p1', 'Prov A', 'https://x', 'bearer', 1, 1, 0)",
  ).run();
  db.query(
    "INSERT INTO models (model_name, provider_id, context_length, is_active, is_primary) VALUES ('m-one', 'p1', 1000, 1, 0)",
  ).run();
  db.query(
    "INSERT INTO models (model_name, provider_id, context_length, is_active, is_primary) VALUES ('m-two', 'p1', 2000, 1, 0)",
  ).run();
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

describe("models_public setting", () => {
  test("defaults to off", () => {
    expect(mp.isModelsPublic()).toBe(false);
  });

  test("setModelsPublic toggles", () => {
    mp.setModelsPublic(true);
    expect(mp.isModelsPublic()).toBe(true);
    mp.setModelsPublic(false);
    expect(mp.isModelsPublic()).toBe(false);
  });
});

describe("is_public per model", () => {
  test("listPublicModels only returns is_public + active models", () => {
    expect(mp.listPublicModels()).toHaveLength(0);
    const rows = db
      .query("SELECT id FROM models WHERE model_name = 'm-one'")
      .all() as { id: number }[];
    mp.setModelPublic(rows[0].id, true);
    const list = mp.listPublicModels();
    expect(list).toHaveLength(1);
    expect(list[0].model_name).toBe("m-one");
    expect(list[0].owned_by).toBe("Prov A");
  });
});
