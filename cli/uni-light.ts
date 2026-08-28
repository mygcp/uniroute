#!/usr/bin/env bun
// Light wrapper — tidak bundle server (hemat 85M). Butuh bun/node + build/ di runtime.
// Dipakai: install.sh --light, atau GH Release uni-light-*
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { getPidPath, getLogPath, readPid, writePid, removePid, isAlive } from "./pid";
import { runDoctor } from "./doctor";

const VERSION = "1.0.0";

function help() {
  console.log(`
UniRoute light — needs bun or node + build/

Usage: uni-light <command> [options]

Commands:
  start [--port PORT] [-d|--daemon]  Start via bun/node (detect runtime)
  stop | restart | status | logs | doctor | update | version

Detect: which bun → bun server.ts, else which node → node server.ts (node:sqlite fallback)
Install: curl -fsSL .../install.sh | sh -s -- --light
`.trim());
}

function hasCmd(cmd: string): boolean {
  const r = spawnSync("which", [cmd]);
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
  const flags: Record<string, any> = {};
  for (let i = 1; i < a.length; i++) {
    const x = a[i];
    if (x === "-d" || x === "--daemon") flags.daemon = true;
    else if (x === "--port" && a[i + 1]) flags.port = a[++i];
    else if (x.startsWith("--port=")) flags.port = x.split("=")[1];
  }
  return { cmd, flags };
}

async function start(flags: any) {
  const rt = detectRuntime();
  if (!rt) {
    console.error("[uni-light] need bun or node: pkg install nodejs / curl -fsSL https://bun.sh/install | bash");
    console.error("  or use standalone: curl -fsSL .../install.sh | sh  (without --light)");
    process.exit(1);
  }
  const pidPath = getPidPath(), logPath = getLogPath();
  if (flags.daemon) {
    const ex = readPid(pidPath);
    if (ex && isAlive(ex)) { console.error(`already ${ex}`); process.exit(1); }
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = fs.openSync(logPath, "a");
    const child = spawn(rt.cmd, rt.args, { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, PORT: flags.port ? String(flags.port) : process.env.PORT }, cwd: process.cwd() });
    child.unref(); fs.closeSync(fd);
    // wait pid (server.ts akan tulis pid via light? server writes pid? For light, server.ts tidak tulis pid via uni-light, jadi kita tulis pid child)
    writePid(child.pid ?? 0, pidPath);
    console.log(`[uni-light] ${rt.cmd} ${rt.args.join(" ")} pid ${child.pid} log ${logPath}`);
    process.exit(0);
  } else {
    // foreground: exec
    const proc = Bun.spawn([rt.cmd, ...rt.args], { cwd: process.cwd(), stdout: "inherit", stderr: "inherit", stdin: "inherit", env: process.env });
    await proc.exited;
  }
}

async function main() {
  const { cmd, flags } = parse(process.argv);
  if (cmd === "help" || cmd === "--help") { help(); process.exit(0); }
  if (cmd === "start") await start(flags);
  else if (cmd === "doctor") { const r = await runDoctor(); r.checks.forEach(c => console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.msg}`)); process.exit(r.ok ? 0 : 1); }
  else if (cmd === "version") console.log(`uni-light ${VERSION} (${detectRuntime()?.cmd ?? "no runtime"})`);
  else { console.log(`[uni-light] ${cmd} — use standalone uni for full daemon/stop/status/logs/update`); help(); }
}
if (import.meta.main) main();
