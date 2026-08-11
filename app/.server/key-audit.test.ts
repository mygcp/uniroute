import "./test-env";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { resetTestDb } from "./test-db";
import { query } from "./db";

type AuditApi = typeof import("./key-audit");
let api: AuditApi;
let keyId: number;

beforeAll(async () => {
  await resetTestDb();
  api = await import("./key-audit");
  const res = query(
    "INSERT INTO client_api_keys (name, key_hash, key_prefix) VALUES (?, ?, ?)",
  ).run("test-key", randomUUID(), "k_") as { lastInsertRowid?: number };
  keyId = Number(res.lastInsertRowid);
});

afterAll(async () => {
  const { closeDb } = await import("./db");
  closeDb();
});

beforeEach(() => {
  query("DELETE FROM key_audit_logs").run();
  query("DELETE FROM request_logs").run();
});

describe("key-audit", () => {
  test("logAudit inserts and listAudit returns newest-first with fields intact", () => {
    api.logAudit(keyId, "KEY_CREATED", { ip: "1.2.3.4", user_agent: "curl/8" });
    api.logAudit(keyId, "KEY_ROTATED", { model: "gpt-4o", status: 200 });

    const rows = api.listAudit(keyId);
    expect(rows).toHaveLength(2);
    expect(rows[0].action).toBe("KEY_ROTATED");
    expect(rows[1].action).toBe("KEY_CREATED");
    expect(rows[0].key_id).toBe(keyId);
    expect(rows[0].model).toBe("gpt-4o");
    expect(rows[0].status).toBe(200);
    expect(rows[1].ip).toBe("1.2.3.4");
    expect(rows[1].user_agent).toBe("curl/8");
    expect(rows[0].id).toBeGreaterThan(rows[1].id);
  });

  test("auditErrorsLastHour counts only REQUEST rows with status >= 400", () => {
    api.logAudit(keyId, "REQUEST", { model: "gpt-4o", status: 500 });
    api.logAudit(keyId, "REQUEST", { model: "gpt-4o", status: 200 });
    api.logAudit(keyId, "KEY_CREATED");

    expect(api.auditErrorsLastHour(keyId)).toBe(1);
  });

  test("recentAudit filters by sinceTs", () => {
    query(
      "INSERT INTO key_audit_logs (key_id, action, created_at) VALUES (?, 'KEY_CREATED', ?)",
    ).run(keyId, Math.floor(Date.now() / 1000) - 5000);
    api.logAudit(keyId, "KEY_ROTATED");

    const since = Math.floor(Date.now() / 1000) - 100;
    const rows = api.recentAudit(keyId, since);
    expect(rows.map((r) => r.action)).toEqual(["KEY_ROTATED"]);
  });

  test("avgLatencyMs returns average and null when no rows", () => {
    const since = Math.floor(Date.now() / 1000) - 100;
    expect(api.avgLatencyMs(keyId, since)).toBeNull();

    const now = Math.floor(Date.now() / 1000);
    query(
      "INSERT INTO request_logs (api_key_id, duration_ms, created_at) VALUES (?, ?, ?)",
    ).run(keyId, 120, now);
    query(
      "INSERT INTO request_logs (api_key_id, duration_ms, created_at) VALUES (?, ?, ?)",
    ).run(keyId, 80, now);

    expect(api.avgLatencyMs(keyId, since)).toBeCloseTo(100);
  });

  test("logAudit details JSON string round-trips", () => {
    const details = JSON.stringify({ reason: "budget exceeded", balance: 0.5 });
    api.logAudit(keyId, "BUDGET_BLOCKED", { details, cost: 0.25 });

    const rows = api.listAudit(keyId);
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toBe(details);
    expect(JSON.parse(rows[0].details as string)).toEqual({
      reason: "budget exceeded",
      balance: 0.5,
    });
    expect(rows[0].cost).toBe(0.25);
  });
});