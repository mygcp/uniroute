import "./test-env";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { resetTestDb } from "./test-db";

process.env.DATABASE_URL = `/tmp/uniroute-executor-test-${randomUUID()}.db`;

beforeAll(async () => {
  await resetTestDb();
});

import { executeJson, executeStreaming } from "./executor";
import type { ExecutorOptions } from "./executor";

type Calls = { url: string; init: Record<string, unknown> }[];

function makeCalls() {
  const calls: Calls = [];
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as Record<string, unknown> });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

function options(): ExecutorOptions {
  return {
    url: "http://up.example/v1/chat/completions",
    headers: new Headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ model: "gpt-4o" }),
    onComplete: () => {},
  };
}

describe("executeStreaming", () => {
  test("returns 200 on success", async () => {
    const calls = makeCalls();
    const res = await executeStreaming(options());
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
  });

  test("retries once on retryable status (500)", async () => {
    let n = 0;
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      n += 1;
      if (n === 1) {
        return new Response("boom", { status: 500 });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await executeStreaming(options());
    expect(res.status).toBe(200);
    expect(n).toBe(2);
  });

  test("non-retryable status (401) stops, no retry", async () => {
    const calls = makeCalls();
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: (init ?? {}) as Record<string, unknown> });
      return new Response(JSON.stringify({ error: { message: "auth failed" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const res = await executeStreaming(options());
    expect(res.status).toBe(401);
    expect(calls.length).toBe(1);
  });
});

describe("executeJson", () => {
  test("returns parsed upstream json on success", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const result = await executeJson(options());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(200);
      expect(result.json).toMatchObject({ choices: [{ message: { content: "hi" } }] });
    }
  });

  test("returns error for invalid upstream json", async () => {
    globalThis.fetch = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    const result = await executeJson(options());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
    }
  });

  test("forwards upstream error status", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 })) as unknown as typeof fetch;
    const result = await executeJson(options());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });
});
