import "./test-env";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, afterEach, describe, expect, test } from "bun:test";
import { resetTestDb } from "./test-db";

process.env.DATABASE_URL = `/tmp/uniroute-webhook-test-${randomUUID()}.db`;

const origFetch = globalThis.fetch;

let enqueueWebhook: (input: {
  keyId?: number | null;
  event: string;
  url: string;
  payload: unknown;
}) => void;
let deliverPending: () => Promise<void>;
let pendingCount: () => number;
let query: (sql: string) => {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
};

beforeAll(async () => {
  await resetTestDb();
  const webhook = await import("./webhook");
  enqueueWebhook = webhook.enqueueWebhook;
  deliverPending = webhook.deliverPending;
  pendingCount = webhook.pendingCount;
  const db = await import("./db");
  query = db.query;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  query("DELETE FROM webhook_events").run();
});

afterAll(() => {
  globalThis.fetch = origFetch;
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

describe("enqueueWebhook", () => {
  test("skips invalid url (no row inserted)", () => {
    const before = pendingCount();
    enqueueWebhook({ event: "test", url: "ftp://example.com/hook", payload: {} });
    enqueueWebhook({ event: "test", url: "not-a-url", payload: {} });
    expect(pendingCount()).toBe(before);
  });

  test("inserts row and stores JSON payload", () => {
    const payload = { hello: "world", n: 42 };
    enqueueWebhook({ event: "order.created", url: "https://example.com/hook", payload });
    expect(pendingCount()).toBe(1);

    const row = query("SELECT * FROM webhook_events").get();
    expect(row).toBeDefined();
    expect(row!.event).toBe("order.created");
    expect(row!.url).toBe("https://example.com/hook");
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(0);
    expect(JSON.parse(row!.payload as string)).toEqual(payload);
  });
});

describe("deliverPending", () => {
  test("marks success on 2xx response", async () => {
    enqueueWebhook({ event: "e", url: "https://example.com/hook", payload: { x: 1 } });

    const calls: { url: string; init: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      calls.push({ url: String(url), init: (init ?? {}) as Record<string, unknown> });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    await deliverPending();

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://example.com/hook");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ x: 1 });

    const row = query("SELECT * FROM webhook_events").get();
    expect(row!.status).toBe("success");
    expect(query("SELECT COUNT(*) AS c FROM webhook_events WHERE status = 'pending'").get()!.c).toBe(
      0,
    );
  });

  test("retries failed delivery with backoff", async () => {
    enqueueWebhook({ event: "e", url: "https://example.com/hook", payload: {} });
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await deliverPending();

    let row = query("SELECT * FROM webhook_events").get();
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(1);
    expect(Number(row!.next_retry_at)).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // Immediate retry does nothing: next_retry_at is still in the future.
    await deliverPending();
    row = query("SELECT * FROM webhook_events").get();
    expect(row!.attempts).toBe(1);

    // Force a retry by resetting next_retry_at.
    query("UPDATE webhook_events SET next_retry_at = 0").run();
    await deliverPending();
    row = query("SELECT * FROM webhook_events").get();
    expect(row!.attempts).toBe(2);
  });

  test("drops row after WEBHOOK_MAX_ATTEMPTS failures", async () => {
    enqueueWebhook({ event: "e", url: "https://example.com/hook", payload: {} });
    globalThis.fetch = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;

    for (let i = 0; i < 5; i++) {
      await deliverPending();
      query("UPDATE webhook_events SET next_retry_at = 0").run();
    }

    const row = query("SELECT * FROM webhook_events").get();
    expect(row!.attempts).toBe(5);
    expect(row!.status).toBe("dropped");
  });
});