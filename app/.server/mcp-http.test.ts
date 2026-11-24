import "./test-env";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { resetTestDb } from "./test-db";

process.env.DATABASE_URL = `/tmp/uniroute-mcp-http-test-${randomUUID()}.db`;

beforeAll(async () => {
  await resetTestDb();
});

import {
  getRemoteMcpStatus,
  handleMcpHttpRequest,
  rotateRemoteMcpToken,
  setRemoteMcpAuthRequired,
  setRemoteMcpEnabled,
} from "./mcp-http";

describe("Remote HTTP MCP server (/api/mcp)", () => {
  test("returns 503 when disabled", async () => {
    setRemoteMcpEnabled(false);
    const res = await handleMcpHttpRequest(
      new Request("http://localhost/api/mcp", { method: "GET" }),
    );
    expect(res.status).toBe(503);
  });

  test("auto-generates token on enable, enforces Bearer auth, and handles JSON-RPC", async () => {
    delete process.env.UNIROUTE_MCP_TOKEN;
    const { enabled, generatedToken } = setRemoteMcpEnabled(true);
    expect(enabled).toBe(true);
    expect(generatedToken).toBeTruthy();
    expect(generatedToken!.startsWith("umcp_")).toBe(true);

    // Missing token -> 401
    const unauthed = await handleMcpHttpRequest(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      }),
    );
    expect(unauthed.status).toBe(401);

    // Valid token -> initialize & tools/list succeed
    const initRes = await handleMcpHttpRequest(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${generatedToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      }),
    );
    expect(initRes.status).toBe(200);
    const initJson = (await initRes.json()) as {
      result?: { serverInfo?: { name: string } };
    };
    expect(initJson.result?.serverInfo?.name).toBe("uniroute");

    const listRes = await handleMcpHttpRequest(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${generatedToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      }),
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { result?: { tools?: unknown[] } };
    expect((listJson.result?.tools ?? []).length).toBeGreaterThan(20);

    // Notification (no id) -> 202
    const notifRes = await handleMcpHttpRequest(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${generatedToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }),
    );
    expect(notifRes.status).toBe(202);

    // Rotate token invalidates old token
    const rotated = rotateRemoteMcpToken();
    expect(rotated).not.toBe(generatedToken);
    const oldTokRes = await handleMcpHttpRequest(
      new Request("http://localhost/api/mcp", {
        method: "GET",
        headers: { Authorization: `Bearer ${generatedToken}` },
      }),
    );
    expect(oldTokRes.status).toBe(401);

    const newTokRes = await handleMcpHttpRequest(
      new Request("http://localhost/api/mcp", {
        method: "GET",
        headers: { Authorization: `Bearer ${rotated}` },
      }),
    );
    expect(newTokRes.status).toBe(200);

    // Disabling auth allows unauthenticated GET
    setRemoteMcpAuthRequired(false);
    expect(getRemoteMcpStatus().requireAuth).toBe(false);
    const openRes = await handleMcpHttpRequest(
      new Request("http://localhost/api/mcp", { method: "GET" }),
    );
    expect(openRes.status).toBe(200);
  });
});
