import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = `/tmp/uniroute-v1-test-${randomUUID()}.db`;

let action: (args: { request: Request }) => Promise<Response>;
let seed: () => void;
let setRequireApiKey: (enabled: boolean) => void;
let createSession: () => string;

beforeAll(async () => {
  const db = await import("./db");
  db.resetDb();
  const ck = await import("./client-key");
  const auth = await import("./auth");
  const route = await import("../routes/v1.chat.completions");
  const reg = await import("./registry");
  seed = db.seed;
  setRequireApiKey = ck.setRequireApiKey;
  createSession = auth.createSession;
  action = route.action as unknown as (args: { request: Request }) => Promise<Response>;
  seed();
  // Registry di-cache antar test file — sinkronkan dengan DB hasil seed ini.
  reg.reload();
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

function post(headers: Record<string, string> = {}): Promise<Response> {
  return action({
    request: new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "halo" }],
      }),
    }),
  });
}

describe("v1 playground auth", () => {
  test("anonymous request is allowed when require_api_key is off", async () => {
    setRequireApiKey(false);
    const res = await post();
    expect(res.status).toBe(404);
  });

  test("anonymous request is rejected with 401 when require_api_key is on", async () => {
    setRequireApiKey(true);
    const res = await post();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toBe("api key required");
  });

  test("logged-in admin session bypasses require_api_key", async () => {
    setRequireApiKey(true);
    const token = createSession();
    const res = await post({ cookie: `uniroute_session=${token}` });
    expect(res.status).toBe(404);
  });

  test("invalid session does not bypass require_api_key", async () => {
    setRequireApiKey(true);
    const res = await post({ cookie: "uniroute_session=bogus" });
    expect(res.status).toBe(401);
  });
});