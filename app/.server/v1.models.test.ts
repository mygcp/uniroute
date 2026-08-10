import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = `/tmp/uniroute-v1-models-test-${randomUUID()}.db`;

let loader: (args: { request: Request }) => Promise<Response>;
let seed: () => void;
let setRequireApiKey: (enabled: boolean) => void;
let setModelsPublic: (enabled: boolean) => void;
let setModelPublic: (id: number, enabled: boolean) => void;
let createSession: () => string;
let createClientKey: (input: {
  name: string;
  prefix?: string | null;
  allowedModels?: string[] | null;
}) => { key: string; id: number };
let deleteClientKey: (id: number) => void;
let query: (sql: string) => { run: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] };

beforeAll(async () => {
  const db = await import("./db");
  db.resetDb();
  const ck = await import("./client-key");
  const auth = await import("./auth");
  const mp = await import("./model-public");
  const route = await import("../routes/v1.models");
  seed = db.seed;
  query = db.query;
  setRequireApiKey = ck.setRequireApiKey;
  setModelsPublic = mp.setModelsPublic;
  setModelPublic = mp.setModelPublic;
  createSession = auth.createSession;
  createClientKey = ck.createClientKey;
  deleteClientKey = ck.deleteClientKey;
  loader = route.loader as unknown as (args: { request: Request }) => Promise<Response>;
  seed();
  query(
    "INSERT INTO providers (id, name, base_url, auth_type, is_active, weight, priority) VALUES ('p1', 'Provider1', 'https://x', 'bearer', 1, 1, 0)",
  ).run();
  query(
    "INSERT INTO models (model_name, provider_id, context_length, is_active, is_primary) VALUES ('m-public', 'p1', 1000, 1, 0)",
  ).run();
  query(
    "INSERT INTO models (model_name, provider_id, context_length, is_active, is_primary) VALUES ('m-private', 'p1', 2000, 1, 0)",
  ).run();
  const rows = query("SELECT id, model_name FROM models WHERE model_name IN ('m-public','m-private')").all() as { id: number; model_name: string }[];
  for (const row of rows) {
    if (row.model_name === "m-public") setModelPublic(row.id, true);
  }
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

function get(reqHeaders: Record<string, string> = {}): Promise<Response> {
  return loader({
    request: new Request("http://localhost/v1/models", {
      headers: reqHeaders,
    }),
  });
}

describe("GET /v1/models admin session", () => {
  test("returns all active models for admin session", async () => {
    const token = createSession();
    const res = await get({ cookie: `uniroute_session=${token}` });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    const ids = body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain("m-public");
    expect(ids).toContain("m-private");
  });
});

describe("GET /v1/models public", () => {
  test("returns only public models without auth when models_public is on", async () => {
    setModelsPublic(true);
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain("m-public");
    expect(ids).not.toContain("m-private");
    setModelsPublic(false);
  });

  test("returns 403 when models_public is off and no token", async () => {
    const res = await get();
    expect(res.status).toBe(403);
  });
});

describe("GET /v1/models client key", () => {
  test("returns public + allowed models for client key", async () => {
    const { key, id } = createClientKey({
      name: "test-models",
      allowedModels: ["m-private"],
    });
    const res = await get({ authorization: `Bearer ${key}` });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain("m-public");
    expect(ids).toContain("m-private");
    deleteClientKey(id);
  });

  test("returns 401 for invalid key", async () => {
    const res = await get({ authorization: "Bearer sk-fake" });
    expect(res.status).toBe(401);
  });
});
