import "./test-env";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { beforeAll, describe, expect, test } from "bun:test";
import { resetTestDb } from "./test-db";

process.env.DATABASE_URL = `/tmp/uniroute-proxy-resolver-test-${randomUUID()}.db`;

beforeAll(async () => {
  await resetTestDb();
  const db = await import("./db");
  db.seed();
});

import { createPool, createProxy, getProxy } from "./outbound-proxy";
import { fetchUpstream, pickProxy, resolveProxyPool } from "./proxy-resolver";

/** Minimal in-process HTTP CONNECT proxy. After the CONNECT handshake it
 *  answers the inner HTTP request with `respond(requestHead)`. */
async function startConnectProxy(
  respond: (requestHead: Buffer) => string,
): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const headEnd = buf.indexOf("\r\n\r\n");
      if (headEnd === -1) return;
      const head = buf.toString("latin1");
      if (head.startsWith("CONNECT ")) {
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
        buf = Buffer.alloc(0);
        return;
      }
      const response = respond(buf);
      socket.write(response);
      socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return { server, port: addr.port };
}

function unusedPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

async function setupPool(proxies: Array<{ name: string; port: number }>): Promise<number> {
  const ids: number[] = [];
  for (const p of proxies) {
    const proxy = createProxy({
      name: p.name,
      type: "http-connect",
      host: "127.0.0.1",
      port: p.port,
    });
    ids.push(proxy.id);
  }
  return createPool({ name: "test-pool", proxy_ids: ids }).id;
}

describe("resolveProxyPool", () => {
  test("returns null when no pool matches", () => {
    expect(resolveProxyPool({})).toBeNull();
    expect(resolveProxyPool({ apiKeyPoolId: 999 })).toBeNull();
  });

  test("api key pool wins over provider pool", () => {
    const pk = createProxy({ name: "pk", type: "http-connect", host: "h", port: 1 });
    const pv = createProxy({ name: "pv", type: "http-connect", host: "h", port: 2 });
    const keyPool = createPool({ name: "keypool", proxy_ids: [pk.id] });
    const provPool = createPool({ name: "provpool", proxy_ids: [pv.id] });
    const chain = resolveProxyPool({ apiKeyPoolId: keyPool.id, providerPoolId: provPool.id });
    expect(chain?.map((r) => r.proxy.id)).toEqual([pk.id]);
  });

  test("filters out inactive proxies", () => {
    const active = createProxy({ name: "a", type: "http-connect", host: "h", port: 1 });
    const inactive = createProxy({ name: "i", type: "http-connect", host: "h", port: 2 });
    const pool = createPool({ name: "mix", proxy_ids: [active.id, inactive.id] });
    const chain = resolveProxyPool({ providerPoolId: pool.id });
    expect(chain?.length).toBe(2);
    expect(getProxy(inactive.id)).not.toBeNull();
  });
});

describe("pickProxy round-robin", () => {
  test("picks least recently used first", () => {
    const p1 = createProxy({ name: "r1", type: "http-connect", host: "h", port: 1 });
    const p2 = createProxy({ name: "r2", type: "http-connect", host: "h", port: 2 });
    const pool = createPool({ name: "rr", proxy_ids: [p1.id, p2.id] });
    const chain = resolveProxyPool({ providerPoolId: pool.id })!;
    // p1 has older last_used_at (0) → picked first
    expect(pickProxy(chain)?.proxy.id).toBe(p1.id);
  });
});

describe("fetchUpstream", () => {
  test("direct path when no pool resolves", async () => {
    const http = createHttpServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as { port: number };
    try {
      const resp = await fetchUpstream(`http://127.0.0.1:${port}/direct`, {
        method: "GET",
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ ok: true });
    } finally {
      http.close();
    }
  });

  test("routes through HTTP CONNECT proxy", async () => {
    const { server, port } = await startConnectProxy((reqHead) => {
      const text = reqHead.toString("latin1");
      expect(text).toContain("GET /hello HTTP/1.1");
      expect(text).toMatch(/host: upstream\.test/i);
      const body = JSON.stringify({ via: "proxy" });
      return (
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
        "Content-Length: " +
        Buffer.byteLength(body) +
        "\r\n\r\n" +
        body
      );
    });
    try {
      const poolId = await setupPool([{ name: "conn", port }]);
      const resp = await fetchUpstream("http://upstream.test/hello", {
        method: "GET",
        providerPoolId: poolId,
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ via: "proxy" });
    } finally {
      server.close();
    }
  });

  test("streams chunked responses", async () => {
    const { server, port } = await startConnectProxy(() => {
      const body = "data: hello\n\ndata: world\n\n";
      const hex = body.length.toString(16);
      return `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${hex}\r\n${body}\r\n0\r\n\r\n`;
    });
    try {
      const poolId = await setupPool([{ name: "chunk", port }]);
      const resp = await fetchUpstream("http://upstream.test/events", {
        method: "GET",
        providerPoolId: poolId,
      });
      const text = await resp.text();
      expect(text).toBe("data: hello\n\ndata: world\n\n");
    } finally {
      server.close();
    }
  });

  test("failover: dead proxy first, live proxy second", async () => {
    const dead = await unusedPort();
    const { server, port } = await startConnectProxy(() => {
      return "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
    });
    try {
      const poolId = await setupPool([
        { name: "dead", port: dead },
        { name: "live", port },
      ]);
      const resp = await fetchUpstream("http://upstream.test/x", {
        method: "GET",
        providerPoolId: poolId,
      });
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("ok");
    } finally {
      server.close();
    }
  });

  test("401 is returned without failover", async () => {
    const { server, port } = await startConnectProxy(() => {
      return "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n";
    });
    try {
      const poolId = await setupPool([{ name: "auth", port }]);
      const resp = await fetchUpstream("http://upstream.test/secure", {
        method: "GET",
        providerPoolId: poolId,
      });
      expect(resp.status).toBe(401);
    } finally {
      server.close();
    }
  });

  test("all proxies failing returns 502", async () => {
    const dead1 = await unusedPort();
    const dead2 = await unusedPort();
    const poolId = await setupPool([
      { name: "d1", port: dead1 },
      { name: "d2", port: dead2 },
    ]);
    const resp = await fetchUpstream("http://upstream.test/x", {
      method: "GET",
      providerPoolId: poolId,
    });
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error.type).toBe("proxy_error");
  });
});
