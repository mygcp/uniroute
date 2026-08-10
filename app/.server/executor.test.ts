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

function options(proxies: ExecutorOptions["proxies"]): ExecutorOptions {
  return {
    url: "http://up.example/v1/chat/completions",
    headers: new Headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ model: "gpt-4o" }),
    proxies,
    onComplete: () => {},
  };
}

describe("executeStreaming proxy failover", () => {
  test("uses first proxy on success", async () => {
    const calls = makeCalls();
    const res = await executeStreaming(
      options([
        { id: 1, protocol: "http", host: "a", port: 8080, username: "u", password: "p" },
        { id: 2, protocol: "http", host: "b", port: 8081, username: null, password: null },
      ]),
    );
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].init.proxy).toBe("http://u:p@a:8080");
  });

  test("fails over to next proxy on connect error", async () => {
    let n = 0;
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      n += 1;
      if (n === 1) throw new Error("connect refused");
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await executeStreaming(
      options([
        { id: 1, protocol: "socks5", host: "a", port: 1080, username: null, password: null },
        { id: 2, protocol: "socks5", host: "b", port: 1081, username: null, password: null },
      ]),
    );
    expect(res.status).toBe(200);
    expect(n).toBe(2);
  });

  test("non-retryable status (401) stops, not fallback", async () => {
    const calls = makeCalls();
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: (init ?? {}) as Record<string, unknown> });
      return new Response(JSON.stringify({ error: { message: "proxy auth failed" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const res = await executeStreaming(
      options([
        { id: 1, protocol: "http", host: "a", port: 8080, username: "u", password: "bad" },
        { id: 2, protocol: "http", host: "b", port: 8081, username: null, password: null },
      ]),
    );
    expect(res.status).toBe(401);
    expect(calls.length).toBe(1);
  });

  test("no proxies keeps legacy single retry behavior", async () => {
    const calls = makeCalls();
    const res = await executeStreaming(options(undefined));
    expect(res.status).toBe(200);
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
    const result = await executeJson(options(undefined));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(200);
      expect(result.json).toMatchObject({ choices: [{ message: { content: "hi" } }] });
    }
  });

  test("returns error for invalid upstream json", async () => {
    globalThis.fetch = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    const result = await executeJson(options(undefined));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
    }
  });

  test("forwards upstream error status", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 })) as unknown as typeof fetch;
    const result = await executeJson(options(undefined));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });
});
