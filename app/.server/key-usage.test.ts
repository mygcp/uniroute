import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resetTestDb } from "./test-db";

process.env.DATABASE_URL = `/tmp/uniroute-key-usage-test-${randomUUID()}.db`;

type KeyUsageModule = typeof import("./key-usage");
type DbModule = typeof import("./db");

let ku: KeyUsageModule;
let db: DbModule;
let keyId: number;
let last30KeyId: number;
let byDayKeyId: number;

const DAY_MS = 86_400_000;

function isoDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function insertKeyRow(label: string): number {
  const result = db
    .query(`INSERT INTO client_api_keys (name, key_hash, key_prefix) VALUES (?, ?, ?)`)
    .run(`key ${label}`, `hash-${label}`, `sk-${label}`) as { lastInsertRowid: number | bigint };
  return Number(result.lastInsertRowid);
}

function insertRow(
  id: number,
  date: string,
  values: { requests?: number; prompt?: number; completion?: number; cost?: number },
): void {
  db.query(
    `INSERT INTO key_usage_daily (key_id, date, requests, prompt_tokens, completion_tokens, cost)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    date,
    values.requests ?? 0,
    values.prompt ?? 0,
    values.completion ?? 0,
    values.cost ?? 0,
  );
}

beforeAll(async () => {
  await resetTestDb();
  ku = await import("./key-usage");
  db = await import("./db");
  keyId = insertKeyRow("main");
  last30KeyId = insertKeyRow("last30");
  byDayKeyId = insertKeyRow("byday");
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

describe("recordUsage", () => {
  test("accumulates same-day usage across calls", () => {
    ku.recordUsage(keyId, { requests: 1, promptTokens: 10, completionTokens: 5, cost: 0.05 });
    ku.recordUsage(keyId, { requests: 2, promptTokens: 20, completionTokens: 7, cost: 0.12 });
    const today = ku.usageToday(keyId);
    expect(today.requests).toBe(3);
    expect(today.promptTokens).toBe(30);
    expect(today.completionTokens).toBe(12);
    expect(today.cost).toBeCloseTo(0.17);
  });

  test("only updates provided fields (absent deltas stay 0)", () => {
    ku.recordUsage(keyId, { promptTokens: 99 });
    const today = ku.usageToday(keyId);
    expect(today.promptTokens).toBe(129);
    expect(today.requests).toBe(3);
  });
});

describe("usageInRange", () => {
  test("returns zero when nothing in range", () => {
    const empty = ku.usageInRange(keyId, Date.UTC(2020, 0, 1), Date.UTC(2020, 1, 1));
    expect(empty).toEqual({ requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 });
  });

  test("sums rows inside a past window and excludes outside", () => {
    insertRow(keyId, "2026-01-05", { requests: 3, prompt: 30, completion: 15, cost: 0.3 });
    insertRow(keyId, "2026-01-20", { requests: 1, prompt: 5, completion: 2, cost: 0.02 });
    insertRow(keyId, "2026-02-10", { requests: 9, prompt: 90, completion: 45, cost: 0.9 });

    const jan = ku.usageInRange(keyId, Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1));
    expect(jan.requests).toBe(4);
    expect(jan.promptTokens).toBe(35);
    expect(jan.completionTokens).toBe(17);
    expect(jan.cost).toBeCloseTo(0.32);

    const wholeWindow = ku.usageInRange(keyId, Date.UTC(2026, 0, 1), Date.UTC(2026, 2, 1));
    expect(wholeWindow.requests).toBe(13);
    expect(wholeWindow.cost).toBeCloseTo(1.22);

    const febOnly = ku.usageInRange(keyId, Date.UTC(2026, 1, 1), Date.UTC(2026, 2, 1));
    expect(febOnly.requests).toBe(9);
  });
});

describe("date-window helpers", () => {
  test("usageThisMonth sums the current month (today's accumulation) and excludes prior months", () => {
    const sumBefore = ku.usageThisMonth(keyId);
    expect(sumBefore.requests).toBe(3);
    expect(sumBefore.promptTokens).toBe(129);

    const now = new Date();
    const prevMonthLastDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0);
    const prevDay = isoDay(prevMonthLastDay);
    insertRow(keyId, prevDay, { requests: 42, prompt: 420, completion: 210, cost: 4.2 });

    const sumAfter = ku.usageThisMonth(keyId);
    expect(sumAfter).toEqual(sumBefore);

    const prevWindow = ku.usageInRange(
      keyId,
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
      prevMonthLastDay + DAY_MS,
    );
    expect(prevWindow.requests).toBe(42);
    expect(prevWindow.cost).toBeCloseTo(4.2);
  });

  test("usageLast30Days covers a row exactly 30 days ago, excluding an older one", () => {
    const ago30 = isoDay(Date.now() - 30 * DAY_MS);
    const ago31 = isoDay(Date.now() - 31 * DAY_MS);
    expect(ago30).not.toBe(ago31);
    expect(ago31 < ago30).toBe(true);

    insertRow(last30KeyId, ago30, { requests: 7, prompt: 70, completion: 35, cost: 0.7 });
    insertRow(last30KeyId, ago31, { requests: 100, prompt: 1000, completion: 500, cost: 10 });

    const last30 = ku.usageLast30Days(last30KeyId);
    expect(last30.requests).toBe(7);
    expect(last30.promptTokens).toBe(70);
    expect(last30.completionTokens).toBe(35);
    expect(last30.cost).toBeCloseTo(0.7);

    expect(ku.usageToday(last30KeyId)).toEqual({ requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 });
  });
});

describe("usageByDay", () => {
  test("returns the most recent N rows ascending with the expected fields", () => {
    const today = isoDay(Date.now());
    insertRow(byDayKeyId, "2026-03-01", { requests: 1, prompt: 1, completion: 1, cost: 0.01 });
    insertRow(byDayKeyId, "2026-03-02", { requests: 2, prompt: 2, completion: 2, cost: 0.02 });
    insertRow(byDayKeyId, "2026-03-03", { requests: 3, prompt: 3, completion: 3, cost: 0.03 });
    insertRow(byDayKeyId, "2026-03-04", { requests: 4, prompt: 4, completion: 4, cost: 0.04 });
    insertRow(byDayKeyId, "2026-03-05", { requests: 5, prompt: 5, completion: 5, cost: 0.05 });
    insertRow(byDayKeyId, today, { requests: 6, prompt: 6, completion: 6, cost: 0.06 });

    const top3 = ku.usageByDay(byDayKeyId, 3);
    expect(top3).toHaveLength(3);
    expect(top3.map((r) => r.date)).toEqual(["2026-03-04", "2026-03-05", today]);

    const all = ku.usageByDay(byDayKeyId, 10);
    expect(all).toHaveLength(6);
    for (const row of all) {
      expect(typeof row.date).toBe("string");
      expect(typeof row.requests).toBe("number");
      expect(typeof row.prompt_tokens).toBe("number");
      expect(typeof row.completion_tokens).toBe("number");
      expect(typeof row.cost).toBe("number");
    }
    expect(all.map((r) => r.date)).toEqual(["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", today]);
  });

  test("defaults to the last 30 rows", () => {
    const byDay = ku.usageByDay(byDayKeyId);
    expect(byDay.length).toBeLessThanOrEqual(30);
  });
});