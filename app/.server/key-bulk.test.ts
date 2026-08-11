import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resetTestDb } from "./test-db";
import type { CreateClientKeyInput } from "./client-key";

process.env.DATABASE_URL = `/tmp/uniroute-key-bulk-test-${randomUUID()}.db`;

type BulkModule = typeof import("./key-bulk");
type ClientKeyModule = typeof import("./client-key");
let bm: BulkModule;
let ck: ClientKeyModule;

beforeAll(async () => {
  await resetTestDb();
  bm = await import("./key-bulk");
  ck = await import("./client-key");
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

function seed(n: number, extra: Partial<CreateClientKeyInput> = {}): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const { id } = ck.createClientKey({ name: `bulk-${i}`, ...extra });
    ids.push(id);
  }
  return ids;
}

beforeEach(() => {
  for (const k of ck.listClientKeys()) ck.deleteClientKey(k.id);
});

describe("key bulk", () => {
  test("suspend action applies to all filtered keys", () => {
    const ids = seed(3);
    const res = bm.applyBulk({}, "suspend");
    expect(res.done).toBe(3);
    for (const id of ids) expect(ck.getClientKeyById(id)!.blocked_at).not.toBeNull();
  });

  test("activate action unblocks suspended keys", () => {
    const ids = seed(2);
    bm.applyBulk({}, "suspend");
    const res = bm.applyBulk({ status: "suspended" }, "activate");
    expect(res.done).toBe(2);
    for (const id of ids) expect(ck.getClientKeyById(id)!.blocked_at).toBeNull();
  });

  test("delete action removes filtered keys", () => {
    seed(4);
    const before = ck.listClientKeys().length;
    const res = bm.applyBulk({}, "delete");
    expect(res.done).toBe(before);
    expect(ck.listClientKeys().length).toBe(0);
  });

  test("rotate action rotates and returns new keys", () => {
    seed(2);
    const res = bm.applyBulk({}, "rotate");
    expect(res.done).toBe(2);
    expect(res.rotated?.length).toBe(2);
  });

  test("extend_expiry sets expires_at", () => {
    const ids = seed(1);
    bm.applyBulk({}, "extend_expiry", { expiresAt: 2000000000 });
    expect(ck.getClientKeyById(ids[0])!.expires_at).toBe(2000000000);
  });

  test("set_budget updates budget", () => {
    const ids = seed(1);
    bm.applyBulk({}, "set_budget", { budget: { monthly: 42 } });
    expect(ck.getClientKeyById(ids[0])!.budget).toEqual({ monthly: 42 });
  });

  test("export returns keys and csv serializes", () => {
    seed(2);
    const res = bm.applyBulk({}, "export");
    expect(res.exported?.length).toBe(2);
    const csv = bm.exportKeysCsv(res.exported!);
    expect(csv.split("\n").length).toBe(3); // header + 2 rows
    expect(csv).toContain("key_prefix");
  });
});