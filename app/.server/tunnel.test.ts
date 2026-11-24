import "./test-env";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_TUNNEL_SETTINGS } from "../lib/tunnel-options";
import { resetTestDb } from "./test-db";

process.env.DATABASE_URL = `/tmp/uniroute-tunnel-test-${randomUUID()}.db`;

beforeAll(async () => {
  await resetTestDb();
});

import {
  buildTunnelSpawnSpec,
  formatHostPort,
  getPublicTunnelSettings,
  getTunnelSettings,
  isLoopbackOrigin,
  normalizeDomain,
  normalizeLocalHost,
  parseTunnelOutputLine,
  resolveGatewayOrigin,
  resolveReachableLocalHost,
  saveTunnelSettings,
  scrubSecrets,
} from "./tunnel";

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("tunnel helpers & runtime config", () => {
  test("normalizeDomain strips schemes/paths and rejects invalid hostnames", () => {
    expect(normalizeDomain("")).toBe("");
    expect(normalizeDomain("  HTTPS://AI.Example.com/v1/chat  ")).toBe(
      "ai.example.com",
    );
    expect(normalizeDomain("sub-1.gateway.io.")).toBe("sub-1.gateway.io");

    expect(() => normalizeDomain("localhost")).toThrow();
    expect(() => normalizeDomain("bad host.com")).toThrow();
    expect(() => normalizeDomain("bad;cmd.com")).toThrow();
    expect(() => normalizeDomain("-leading.example.com")).toThrow();
  });

  test("scrubSecrets redacts all non-empty tokens from log lines", () => {
    const out = scrubSecrets(
      "connecting with token=sec_alpha_123 and pass=sec_beta_456",
      ["sec_alpha_123", "", "sec_beta_456"],
    );
    expect(out).toBe("connecting with token=[redacted] and pass=[redacted]");
  });

  test("buildTunnelSpawnSpec builds correct args/env for cloudflared quick & token", () => {
    const quick = buildTunnelSpawnSpec(
      {
        ...DEFAULT_TUNNEL_SETTINGS,
        provider: "cloudflared",
        cloudflared_mode: "quick",
        cloudflared_protocol: "http2",
        local_host: "127.0.0.1",
      },
      "/bin/cloudflared",
      3000,
    );
    expect(quick.args).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--protocol",
      "http2",
      "--url",
      "http://127.0.0.1:3000",
    ]);
    expect(quick.env).toEqual({});

    expect(() =>
      buildTunnelSpawnSpec(
        {
          ...DEFAULT_TUNNEL_SETTINGS,
          provider: "cloudflared",
          cloudflared_mode: "token",
          cloudflared_token: "",
        },
        "/bin/cloudflared",
        3000,
      ),
    ).toThrow();

    const named = buildTunnelSpawnSpec(
      {
        ...DEFAULT_TUNNEL_SETTINGS,
        provider: "cloudflared",
        cloudflared_mode: "token",
        cloudflared_token: "cf_tok_secret",
        custom_domain: "ai.example.com",
        prefer_https: true,
      },
      "/bin/cloudflared",
      3000,
    );
    expect(named.args).toEqual(["tunnel", "--no-autoupdate", "run"]);
    expect(named.env).toEqual({ TUNNEL_TOKEN: "cf_tok_secret" });
    expect(named.expectedPublicUrl).toBe("https://ai.example.com");
  });

  test("buildTunnelSpawnSpec builds correct spec for ngrok, frpc, and bore", () => {
    const ngrokSpec = buildTunnelSpawnSpec(
      {
        ...DEFAULT_TUNNEL_SETTINGS,
        provider: "ngrok",
        ngrok_authtoken: "ng_secret_123",
        ngrok_region: "ap",
        custom_domain: "llm.example.org",
      },
      "/bin/ngrok",
      5173,
    );
    expect(ngrokSpec.args).toEqual([
      "http",
      "127.0.0.1:5173",
      "--log=stdout",
      "--log-format=json",
      "--region",
      "ap",
      "--url=llm.example.org",
    ]);
    expect(ngrokSpec.env).toEqual({ NGROK_AUTHTOKEN: "ng_secret_123" });
    expect(ngrokSpec.expectedPublicUrl).toBe("https://llm.example.org");

    const dir = mkdtempSync(path.join(os.tmpdir(), "uniroute-frpc-test-"));
    tmpDirs.push(dir);
    const frpSpec = buildTunnelSpawnSpec(
      {
        ...DEFAULT_TUNNEL_SETTINGS,
        provider: "frpc",
        frpc_server_addr: "vps.example.com",
        frpc_server_port: 7000,
        frpc_token: "frp_secret_xyz",
        frpc_protocol: "http",
        frpc_subdomain: "uni",
        custom_domain: "api.example.com",
      },
      "/bin/frpc",
      3000,
      { configDir: dir },
    );
    expect(frpSpec.args).toEqual(["-c", path.join(dir, "frpc.toml")]);
    expect(frpSpec.expectedPublicUrl).toBe("https://api.example.com");
    const toml = readFileSync(frpSpec.configPath!, "utf8");
    expect(toml).toContain('serverAddr = "vps.example.com"');
    expect(toml).toContain('auth.token = "frp_secret_xyz"');
    expect(toml).toContain('customDomains = ["api.example.com"]');
    expect(toml).toContain('subdomain = "uni"');
    if (process.platform !== "win32") {
      expect(statSync(frpSpec.configPath!).mode & 0o777).toBe(0o600);
    }

    const boreSpec = buildTunnelSpawnSpec(
      {
        ...DEFAULT_TUNNEL_SETTINGS,
        provider: "bore",
        bore_server: "bore.pub",
        bore_remote_port: 41234,
        bore_secret: "bore_sec",
      },
      "/bin/bore",
      3000,
    );
    expect(boreSpec.args).toEqual([
      "local",
      "3000",
      "--local-host",
      "127.0.0.1",
      "--to",
      "bore.pub",
      "--port",
      "41234",
    ]);
    expect(boreSpec.env).toEqual({ BORE_SECRET: "bore_sec" });
  });

  test("parseTunnelOutputLine parses URLs and errors for all 4 providers", () => {
    expect(
      parseTunnelOutputLine(
        "cloudflared",
        "2026-11-24T00:00:00Z INF |  https://bright-fox-123.trycloudflare.com  |",
        DEFAULT_TUNNEL_SETTINGS,
      ),
    ).toEqual({
      publicUrl: "https://bright-fox-123.trycloudflare.com",
      connected: true,
    });

    expect(
      parseTunnelOutputLine(
        "cloudflared",
        "2026-11-24T00:00:01Z INF Registered tunnel connection connIndex=0",
        {
          ...DEFAULT_TUNNEL_SETTINGS,
          cloudflared_mode: "token",
          custom_domain: "ai.example.com",
        },
      ),
    ).toEqual({
      connected: true,
      publicUrl: "https://ai.example.com",
    });

    expect(
      parseTunnelOutputLine(
        "ngrok",
        JSON.stringify({ msg: "started tunnel", url: "https://demo.ngrok-free.app" }),
        DEFAULT_TUNNEL_SETTINGS,
      ),
    ).toEqual({
      publicUrl: "https://demo.ngrok-free.app",
      connected: true,
    });

    expect(
      parseTunnelOutputLine(
        "ngrok",
        JSON.stringify({ lvl: "eror", err: "ERR_NGROK_108" }),
        DEFAULT_TUNNEL_SETTINGS,
      ),
    ).toEqual({ error: "ERR_NGROK_108" });

    expect(
      parseTunnelOutputLine(
        "frpc",
        "2026-11-24 [I] [control.go:172] [uniroute] start proxy success",
        {
          ...DEFAULT_TUNNEL_SETTINGS,
          custom_domain: "frp.example.com",
        },
      ),
    ).toEqual({
      connected: true,
      publicUrl: "https://frp.example.com",
    });

    expect(
      parseTunnelOutputLine(
        "bore",
        "2026-11-24T00:00:00Z INFO bore_cli::client: listening at bore.pub:55123",
        DEFAULT_TUNNEL_SETTINGS,
      ),
    ).toEqual({
      connected: true,
      publicUrl: "http://bore.pub:55123",
    });
  });

  test("saveTunnelSettings preserves saved secrets unless explicitly cleared", () => {
    saveTunnelSettings({
      provider: "ngrok",
      auto_start: true,
      auto_reconnect: true,
      custom_domain: "https://gateway.example.com/path",
      ngrok_authtoken: "ng_tok_abc",
      cloudflared_token: "cf_tok_xyz",
    });

    const pub1 = getPublicTunnelSettings();
    expect(pub1.provider).toBe("ngrok");
    expect(pub1.auto_start).toBe(true);
    expect(pub1.custom_domain).toBe("gateway.example.com");
    expect(pub1.has_ngrok_authtoken).toBe(true);
    expect(pub1.has_cloudflared_token).toBe(true);
    expect("ngrok_authtoken" in pub1).toBe(false);

    // Updating another field with blank secrets must keep saved tokens.
    saveTunnelSettings({
      ngrok_region: "eu",
      ngrok_authtoken: "",
    });
    expect(getTunnelSettings().ngrok_authtoken).toBe("ng_tok_abc");
    expect(getTunnelSettings().ngrok_region).toBe("eu");

    // Explicit clear flag erases the stored secret.
    saveTunnelSettings({ clear_ngrok_authtoken: true });
    expect(getTunnelSettings().ngrok_authtoken).toBe("");
    expect(getPublicTunnelSettings().has_ngrok_authtoken).toBe(false);
  });

  test("normalizeLocalHost and formatHostPort handle IPv6 hosts cleanly", () => {
    expect(normalizeLocalHost("[::1]")).toBe("::1");
    expect(normalizeLocalHost("")).toBe("127.0.0.1");
    expect(formatHostPort("::1", 5173)).toBe("[::1]:5173");
    expect(formatHostPort("127.0.0.1", 5173)).toBe("127.0.0.1:5173");

    const cfV6 = buildTunnelSpawnSpec(
      { ...DEFAULT_TUNNEL_SETTINGS, provider: "cloudflared", local_host: "::1" },
      "/bin/cloudflared",
      5173,
    );
    expect(cfV6.args).toContain("http://[::1]:5173");

    const ngrokV6 = buildTunnelSpawnSpec(
      { ...DEFAULT_TUNNEL_SETTINGS, provider: "ngrok", local_host: "::1" },
      "/bin/ngrok",
      5173,
    );
    expect(ngrokV6.args).toContain("[::1]:5173");

    const dir = mkdtempSync(path.join(os.tmpdir(), "uniroute-frpc-v6-test-"));
    tmpDirs.push(dir);
    const frpV6 = buildTunnelSpawnSpec(
      {
        ...DEFAULT_TUNNEL_SETTINGS,
        provider: "frpc",
        local_host: "::1",
        frpc_server_addr: "vps.example.com",
        custom_domain: "api.example.com",
      },
      "/bin/frpc",
      5173,
      { configDir: dir },
    );
    expect(readFileSync(frpV6.configPath!, "utf8")).toContain('localIP = "::1"');

    const boreV6 = buildTunnelSpawnSpec(
      { ...DEFAULT_TUNNEL_SETTINGS, provider: "bore", local_host: "::1" },
      "/bin/bore",
      5173,
    );
    expect(boreV6.args).toContain("::1");
  });

  test("resolveReachableLocalHost falls back across IPv4/IPv6 loopback", async () => {
    const v6Server = createServer();
    await new Promise<void>((resolve, reject) => {
      v6Server.once("error", reject);
      v6Server.listen(0, "::1", () => resolve());
    });
    const v6Port = (v6Server.address() as AddressInfo).port;
    try {
      expect(await resolveReachableLocalHost("127.0.0.1", v6Port)).toBe("::1");
    } finally {
      await new Promise<void>((resolve) => v6Server.close(() => resolve()));
    }

    const v4Server = createServer();
    await new Promise<void>((resolve, reject) => {
      v4Server.once("error", reject);
      v4Server.listen(0, "127.0.0.1", () => resolve());
    });
    const v4Port = (v4Server.address() as AddressInfo).port;
    try {
      expect(await resolveReachableLocalHost("::1", v4Port)).toBe("127.0.0.1");
    } finally {
      await new Promise<void>((resolve) => v4Server.close(() => resolve()));
    }
  });

  test("isLoopbackOrigin and resolveGatewayOrigin handle tunnels, public domains, and BASE_URL", () => {
    expect(isLoopbackOrigin("http://localhost:3000")).toBe(true);
    expect(isLoopbackOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:5173")).toBe(true);
    expect(isLoopbackOrigin("https://ai.example.com")).toBe(false);

    const prevBase = process.env.BASE_URL;
    const rtSym = Symbol.for("uniroute.tunnelRuntime");
    const g = globalThis as Record<symbol, { status?: string; publicUrl?: string | null } | undefined>;
    const prevRt = g[rtSym] ? { ...g[rtSym] } : undefined;

    try {
      process.env.BASE_URL = "http://localhost:3000";
      const localReq = new Request("http://localhost:5173/home");
      expect(resolveGatewayOrigin(localReq)).toBe("http://localhost:3000");

      const proxyReq = new Request("http://localhost:5173/home", {
        headers: {
          "x-forwarded-host": "ai.yourdomain.com",
          "x-forwarded-proto": "https",
        },
      });
      expect(resolveGatewayOrigin(proxyReq)).toBe("https://ai.yourdomain.com");

      process.env.BASE_URL = "https://configured.example.com/";
      expect(resolveGatewayOrigin(localReq)).toBe("https://configured.example.com");

      g[rtSym] = {
        ...(g[rtSym] ?? {}),
        status: "running",
        publicUrl: "https://live-tunnel.trycloudflare.com",
      };
      expect(resolveGatewayOrigin(localReq)).toBe(
        "https://live-tunnel.trycloudflare.com",
      );
    } finally {
      if (prevBase === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = prevBase;
      if (prevRt && g[rtSym]) {
        Object.assign(g[rtSym]!, prevRt);
      }
    }
  });
});
