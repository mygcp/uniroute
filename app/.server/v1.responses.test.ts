import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = `/tmp/uniroute-v1-responses-test-${randomUUID()}.db`;

let action: (args: { request: Request }) => Promise<Response>;
let seed: () => void;
let setRequireApiKey: (enabled: boolean) => void;
let createSession: () => string;

beforeAll(async () => {
  const db = await import("./db");
  db.resetDb();
  const ck = await import("./client-key");
  const auth = await import("./auth");
  const route = await import("../routes/v1.responses");
  seed = db.seed;
  setRequireApiKey = ck.setRequireApiKey;
  createSession = auth.createSession;
  action = route.action as unknown as (args: { request: Request }) => Promise<Response>;
  seed();
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

function post(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return action({
    request: new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  });
}

describe("v1/responses auth", () => {
  test("anonymous allowed when require_api_key off", async () => {
    setRequireApiKey(false);
    const res = await post({ model: "gpt-4o", input: "hi" });
    expect(res.status).toBe(404);
  });

  test("anonymous rejected when require_api_key on", async () => {
    setRequireApiKey(true);
    const res = await post({ model: "gpt-4o", input: "hi" });
    expect(res.status).toBe(401);
    setRequireApiKey(false);
  });

  test("session admin bypasses require_api_key", async () => {
    setRequireApiKey(true);
    const token = createSession();
    const res = await post(
      { model: "gpt-4o", input: "hi" },
      { cookie: `uniroute_session=${token}` },
    );
    expect(res.status).toBe(404);
    setRequireApiKey(false);
  });
});

describe("v1/responses validation", () => {
  test("returns 400 for missing model", async () => {
    const res = await post({ input: "hi" });
    expect(res.status).toBe(400);
  });
});
