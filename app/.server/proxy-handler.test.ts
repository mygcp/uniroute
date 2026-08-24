import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = `/tmp/uniroute-proxy-handler-test-${randomUUID()}.db`;

let handleProxy: typeof import("./proxy-handler").handleProxy;
let parseChat: typeof import("./translate/from-openai-chat").parse;
let seed: () => void;
let setRequireApiKey: (enabled: boolean) => void;
let createSession: () => string;

beforeAll(async () => {
  const db = await import("./db");
  db.resetDb();
  const ck = await import("./client-key");
  const auth = await import("./auth");
  const handler = await import("./proxy-handler");
  const translate = await import("./translate/from-openai-chat");
  const reg = await import("./registry");
  seed = db.seed;
  setRequireApiKey = ck.setRequireApiKey;
  createSession = auth.createSession;
  handleProxy = handler.handleProxy;
  parseChat = translate.parse;
  seed();
  // Registry tidak lagi di-reload per-request (optimasi jalur panas) —
  // sinkronkan cache dengan DB hasil seed ini secara eksplisit.
  reg.reload();
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

function post(
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return handleProxy(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { clientFormat: "openai-chat", parse: parseChat },
  );
}

describe("proxy-handler validation", () => {
  test("returns 400 for invalid JSON body", async () => {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const res = await handleProxy(req, { clientFormat: "openai-chat", parse: parseChat });
    expect(res.status).toBe(400);
  });

  test("returns 400 for missing model", async () => {
    const res = await handleProxy(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
      { clientFormat: "openai-chat", parse: parseChat },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("model is required");
  });

  test("returns 401 when require_api_key is on and no token", async () => {
    setRequireApiKey(true);
    const res = await post({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
    setRequireApiKey(false);
  });

  test("admin session bypasses require_api_key", async () => {
    setRequireApiKey(true);
    const token = createSession();
    const res = await post(
      { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      { cookie: `uniroute_session=${token}` },
    );
    expect(res.status).not.toBe(401);
    setRequireApiKey(false);
  });

  test("returns 404 for model not in provider pool", async () => {
    setRequireApiKey(false);
    const res = await post({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.message).toBe("model not found");
  });
});
