import "./test-env";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetTestDb } from "./test-db";

process.env.DATABASE_URL = `/tmp/uniroute-compressor-test-${randomUUID()}.db`;

beforeAll(async () => {
  await resetTestDb();
});

import {
  compress,
  compressCanonicalRequest,
  getSettings,
  isEnabled,
  saveSettings,
  testCompression,
} from "./compressor";
import { query } from "./db";

function setSettings(opts: {
  rtk?: number;
  caveman?: number;
  rtkPath?: string;
  cavemanPath?: string;
}) {
  query(
    `INSERT INTO compression_settings
       (id, rtk_enabled, caveman_enabled, rtk_binary_path, caveman_binary_path, updated_at)
     VALUES (1, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       rtk_enabled = ?, caveman_enabled = ?, rtk_binary_path = ?, caveman_binary_path = ?, updated_at = unixepoch()`,
  ).run(
    opts.rtk ?? 0,
    opts.caveman ?? 0,
    opts.rtkPath ?? "./bin/rtk",
    opts.cavemanPath ?? "./bin/caveman",
    opts.rtk ?? 0,
    opts.caveman ?? 0,
    opts.rtkPath ?? "./bin/rtk",
    opts.cavemanPath ?? "./bin/caveman",
  );
}

afterAll(() => {
  // restore seed defaults
  setSettings({ rtk: 1, caveman: 0 });
});

describe("compressor settings", () => {
  test("disabled by default behavior", () => {
    setSettings({ rtk: 0, caveman: 0 });
    expect(isEnabled()).toEqual({ rtk: false, caveman: false });
  });

  test("enables reflect settings", () => {
    setSettings({ rtk: 1, caveman: 1 });
    expect(isEnabled()).toEqual({ rtk: true, caveman: true });
  });
});

describe("compress", () => {
  test("returns prompt unchanged when disabled", async () => {
    setSettings({ rtk: 0, caveman: 0 });
    const r = await compress("halo dunia");
    expect(r.output).toBe("halo dunia");
    expect(r.usedFallback).toBe(false);
    expect(r.durationMs).toBe(0);
  });

  test("passes through dummy rtk+caveman binaries", async () => {
    setSettings({ rtk: 1, caveman: 1 });
    const r = await compress("halo");
    expect(r.output).toBe("halo");
    expect(r.usedFallback).toBe(false);
  }, 10000);

  test("falls back when binary is missing", async () => {
    setSettings({ rtk: 1, caveman: 0, rtkPath: "./bin/does-not-exist" });
    query("DELETE FROM proxy_logs").run();
    const r = await compress("halo");
    expect(r.output).toBe("halo");
    expect(r.usedFallback).toBe(true);
    await Bun.sleep(5);
    const warn = query(
      "SELECT COUNT(*) AS c FROM proxy_logs WHERE source = 'compressor' AND level = 'warn'",
    ).get() as { c: number };
    expect(warn.c).toBeGreaterThan(0);
  }, 10000);

  test("falls back when binary times out (5s)", async () => {
    setSettings({ rtk: 1, caveman: 0, rtkPath: "./bin/sleep-binary" });
    const start = Date.now();
    const r = await compress("halo");
    const elapsed = Date.now() - start;
    expect(r.usedFallback).toBe(true);
    expect(r.output).toBe("halo");
    expect(elapsed).toBeLessThan(8000);
  }, 15000);
});

describe("testCompression", () => {
  test("runs regardless of enabled state and returns settings", async () => {
    setSettings({ rtk: 1, caveman: 0 });
    const r = await testCompression("sample prompt");
    expect(r.output).toBe("sample prompt");
    expect(r.settings.rtk_enabled).toBe(true);
  }, 10000);
});

describe("compressCanonicalRequest (global pipeline)", () => {
  test("injects Caveman output voice globally without duplicating", async () => {
    saveSettings({
      rtk_enabled: false,
      caveman_enabled: false,
      caveman_voice: "caveman",
    });
    const req = {
      model: "gpt-4o",
      stream: false,
      extra: {},
      messages: [
        { role: "system" as const, content: "You are a helpful coder." },
        { role: "user" as const, content: "Why does React rerender?" },
      ],
    };
    const r1 = await compressCanonicalRequest(req);
    expect(r1.voiceInjected).toBe(true);
    expect(String(req.messages[0]!.content)).toContain("[Caveman Mode]");

    // Calling again should not duplicate the directive
    const r2 = await compressCanonicalRequest(req);
    expect(r2.voiceInjected).toBe(false);

    saveSettings({ caveman_voice: "off" });
  });
});