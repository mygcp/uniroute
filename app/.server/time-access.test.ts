import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = `/tmp/uniroute-time-access-test-${randomUUID()}.db`;

type TimeAccessModule = typeof import("./time-access");
let ta: TimeAccessModule;

beforeAll(async () => {
  ta = await import("./time-access");
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

const at = (s: string): Date => new Date(s);

describe("time access", () => {
  test("null / disabled config is allowed", () => {
    expect(ta.isWithinAccessHours(null, at("2026-08-07T03:00:00Z")).allowed).toBe(true);
    expect(
      ta.isWithinAccessHours({ enabled: false }, at("2026-08-07T03:00:00Z")).allowed,
    ).toBe(true);
  });

  test("allowed_days restrict weekday (UTC)", () => {
    const cfg = { enabled: true, timezone: "UTC", allowed_days: ["friday"] };
    expect(ta.isWithinAccessHours(cfg, at("2026-08-07T03:00:00Z")).allowed).toBe(true);
    expect(ta.isWithinAccessHours(cfg, at("2026-08-08T03:00:00Z")).allowed).toBe(false);
  });

  test("empty allowed_days means all days", () => {
    const cfg = { enabled: true, timezone: "UTC", allowed_days: [] as string[] };
    expect(ta.isWithinAccessHours(cfg, at("2026-08-08T03:00:00Z")).allowed).toBe(true);
  });

  test("window start/end enforces half-open [start, end)", () => {
    const cfg = { enabled: true, timezone: "UTC", start_time: "08:00", end_time: "18:00" };
    expect(ta.isWithinAccessHours(cfg, at("2026-08-07T09:00:00Z")).allowed).toBe(true);
    expect(ta.isWithinAccessHours(cfg, at("2026-08-07T07:59:00Z")).allowed).toBe(false);
    expect(ta.isWithinAccessHours(cfg, at("2026-08-07T08:00:00Z")).allowed).toBe(true);
    expect(ta.isWithinAccessHours(cfg, at("2026-08-07T18:00:00Z")).allowed).toBe(false);
    expect(ta.isWithinAccessHours(cfg, at("2026-08-07T17:59:00Z")).allowed).toBe(true);
  });

  test("only start_time", () => {
    const cfg = { enabled: true, timezone: "UTC", start_time: "08:00" };
    expect(ta.isWithinAccessHours(cfg, at("2026-08-07T08:00:00Z")).allowed).toBe(true);
    expect(ta.isWithinAccessHours(cfg, at("2026-08-07T07:59:00Z")).allowed).toBe(false);
  });

  test("only end_time", () => {
    const cfg = { enabled: true, timezone: "UTC", end_time: "18:00" };
    expect(ta.isWithinAccessHours(cfg, at("2026-08-07T17:59:00Z")).allowed).toBe(true);
    expect(ta.isWithinAccessHours(cfg, at("2026-08-07T18:00:00Z")).allowed).toBe(false);
  });

  test("malformed config never hard-blocks", () => {
    expect(
      ta.isWithinAccessHours({ enabled: true, start_time: "garbage", end_time: "nope" }).allowed,
    ).toBe(true);
    expect(
      ta.isWithinAccessHours({ enabled: true, start_time: "25:00", end_time: "99:99" }).allowed,
    ).toBe(true);
  });

  test("non-UTC timezone shifts the window", () => {
    const cfg = { enabled: true, timezone: "Asia/Jakarta", start_time: "15:00", end_time: "16:00" };
    const now = new Date("2026-08-07T08:30:00Z"); // 15:30 WIB
    expect(ta.isWithinAccessHours(cfg, now).allowed).toBe(true);
    const before = new Date("2026-08-07T06:00:00Z"); // 13:00 WIB
    expect(ta.isWithinAccessHours(cfg, before).allowed).toBe(false);
  });
});