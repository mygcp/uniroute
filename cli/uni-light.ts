#!/usr/bin/env bun
// Lightweight CLI wrapper that delegates to Bun or Node.js with build/ at runtime.
import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { getPidPath, getLogPath, readPid, writePid, removePid, isAlive } from "./pid";
import { runDoctor } from "./doctor";
import pkg from "../package.json";

const VERSION = pkg.version || "1.1.0";

function help() {
  console.log(`
UniRoute light - needs Bun or Node.js >= 22.5 + build/

Usage: uni-light <command> [options]

Commands:
  start [--port PORT] [-d|--daemon]  Start via bun or node
  doctor | version | help
`.trim());
}

function hasCmd(cmd: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [cmd], { stdio: "ignore" });
  return r.status === 0;
}

function detectRuntime(): { cmd: string; args: string[] } | null {
  if (hasCmd("bun")) return { cmd: "bun", args: ["server.ts"] };
  if (hasCmd("node")) return { cmd: "node", args: ["server.ts"] };
  return null;
}

function parse(v: string[]) {
  const a = v.slice(2);
  const cmd = a[0] ?? "help";
  const flags: Record<string, string | boolean> = {};
  for (let i = 1; i < a.length; i++) {
    const x = a[i];
    if (x === "-d" || x === "--daemon") flags.daemon = true;
    else if (x === "--port" && a[i + 1]) flags.port = a[++i];
    else if (x.startsWith("--port=")) flags.port = x.split("=")[1];
  }
  return { cmd, flags };
}

async function start(flags: Record<string, string | boolean>) {
  const rt = detectRuntime();
  if (!rt) {
    console.error("[uni-light] need Bun or Node.js >= 22.5");
    process.exit(1);
  }
  const pidPath = getPidPath();
  const logPath = getLogPath();
  if (flags.daemon) {
    const ex = readPid(pidPath);
    if (ex && isAlive(ex)) {
      console.error(`already running (pid ${ex})`);
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, "a");
    const child = spawn(rt.cmd, rt.args, {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, PORT: flags.port ? String(flags.port) : process.env.PORT },
      cwd: process.cwd(),
    });
    child.unref();
    fs.closeSync(fd);
    writePid(child.pid ?? 0, pidPath);
    console.log(`[uni-light] ${rt.cmd} ${rt.args.join(" ")} pid ${child.pid} log ${logPath}`);
    process.exit(0);
  }
  const proc = spawn(rt.cmd, rt.args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, PORT: flags.port ? String(flags.port) : process.env.PORT },
  });
  await new Promise<void>((resolve) => {
    proc.on("exit", (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}

async function main() {
  const { cmd, flags } = parse(process.argv);
  if (cmd === "help" || cmd === "--help") {
    help();
    process.exit(0);
  }
  if (cmd === "start") {
    await start(flags);
  } else if (cmd === "doctor") {
    const r = await runDoctor();
    r.checks.forEach((c) => console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.msg}`));
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === "version") {
    console.log(`uni-light ${VERSION} (${detectRuntime()?.cmd ?? "no runtime"})`);
  } else {
    console.log(`[uni-light] ${cmd}: use 'uni' for full daemon/stop/status/logs/update`);
    help();
  }
}

if (import.meta.main) {
  void main();
}
