import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resetTestDb } from "./test-db";

process.env.DATABASE_URL = `/tmp/uniroute-key-groups-test-${randomUUID()}.db`;

type GroupsModule = typeof import("./key-groups");
type ClientKeyModule = typeof import("./client-key");
let gm: GroupsModule;
let ck: ClientKeyModule;

beforeAll(async () => {
  await resetTestDb();
  gm = await import("./key-groups");
  ck = await import("./client-key");
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

describe("key groups", () => {
  test("createGroup, listGroups, getGroup, deleteGroup", () => {
    const id = gm.createGroup("eng", "Engineering team", { monthly_budget: 100 }, []);
    expect(id).toBeGreaterThan(0);
    expect(gm.listGroups().some((g) => g.name === "eng")).toBe(true);
    expect(gm.getGroup(id)?.description).toBe("Engineering team");
    expect(gm.getGroup(id)?.shared_quota).toEqual({ monthly_budget: 100 });
    gm.deleteGroup(id);
    expect(gm.getGroup(id)).toBeUndefined();
  });

  test("updateGroup merges shared quota", () => {
    const id = gm.createGroup("eng2", null, { monthly_budget: 100 }, []);
    gm.updateGroup(id, { sharedQuota: { monthly_budget: 50, tokens_per_month: 200 } });
    expect(gm.getGroup(id)?.shared_quota).toEqual({ monthly_budget: 50, tokens_per_month: 200 });
    gm.deleteGroup(id);
  });

  test("membership add/remove/set and groupsOfKey", () => {
    const { id: keyId1 } = ck.createClientKey({ name: "m1" });
    const { id: keyId2 } = ck.createClientKey({ name: "m2" });
    const gid = gm.createGroup("team", null, null);
    gm.addGroupMember(gid, keyId1);
    gm.addGroupMember(gid, keyId1);
    gm.addGroupMember(gid, keyId2);
    expect(gm.groupMembers(gid).sort()).toEqual([keyId1, keyId2].sort());
    expect(gm.groupsOfKey(keyId1).map((g) => g.id)).toContain(gid);
    gm.removeGroupMember(gid, keyId1);
    expect(gm.groupMembers(gid)).toEqual([keyId2]);
    gm.setGroupMembers(gid, [keyId1]);
    expect(gm.groupMembers(gid)).toEqual([keyId1]);
    gm.deleteGroup(gid);
  });

  test("groupUsage aggregates member usage this month", async () => {
    const usage = await import("./key-usage");
    const db = await import("./db");
    const { id: keyId1 } = ck.createClientKey({ name: "u1" });
    const { id: keyId2 } = ck.createClientKey({ name: "u2" });
    const today = new Date().toISOString().slice(0, 10);
    db.query("INSERT INTO key_usage_daily (key_id, date, requests, prompt_tokens, cost) VALUES (?, ?, 3, 100, 1.5)")
      .run(keyId1, today);
    usage.recordUsage(keyId2, { requests: 2, promptTokens: 50, cost: 0.5 });
    const gid = gm.createGroup("agg", null, null, [keyId1, keyId2]);
    const total = gm.groupUsage(gm.getGroup(gid)!);
    expect(total.requests).toBe(5);
    expect(total.promptTokens).toBe(150);
    expect(total.cost).toBeCloseTo(2, 3);
    gm.deleteGroup(gid);
  });

  test("checkGroupSharedQuota blocks beyond budget or tokens", async () => {
    const db = await import("./db");
    const { id: keyId } = ck.createClientKey({ name: "member" });
    const today = new Date().toISOString().slice(0, 10);
    db.query("INSERT INTO key_usage_daily (key_id, date, requests, prompt_tokens, completion_tokens, cost) VALUES (?, ?, 1, 40, 40, 9)")
      .run(keyId, today);
    const key = ck.getClientKeyById(keyId)!;

    const budgetGroup = gm.createGroup("b", null, { monthly_budget: 5 }, [keyId]);
    expect(gm.checkGroupSharedQuota(key).ok).toBe(false);
    gm.deleteGroup(budgetGroup);

    const tokenGroup = gm.createGroup("t", null, { tokens_per_month: 60 }, [keyId]);
    expect(gm.checkGroupSharedQuota(key).ok).toBe(false);
    gm.deleteGroup(tokenGroup);

    const okGroup = gm.createGroup("ok", null, { monthly_budget: 500 }, [keyId]);
    expect(gm.checkGroupSharedQuota(key).ok).toBe(true);
    gm.deleteGroup(okGroup);
  });
});