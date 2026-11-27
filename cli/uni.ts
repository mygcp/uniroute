#!/usr/bin/env bun
import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pkg from "../package.json";
import { sleepMs } from "../app/.server/http-runtime";
import {
  applyAppUpdate,
  detectBundleDir,
  detectCompiledBinary,
  listGitHubReleases,
  type UpdateProgressEvent,
} from "../app/.server/self-update";
import { getPidPath, getLogPath, readPid, writePid, removePid, isAlive } from "./pid";
import { runDoctor } from "./doctor";

const VERSION = pkg.version || "1.1.0";
const moduleDir =
  typeof import.meta.dir === "string"
    ? import.meta.dir
    : path.dirname(fileURLToPath(import.meta.url));

function isCompiledBinary(): boolean {
  return detectCompiledBinary();
}

function printHelp() {
  console.log(`
UniRoute - self-hosted AI gateway

Usage: uni <command> [options]   (also: uniroute)

Commands:
  start [--port PORT] [--host HOST] [-d|--daemon]   Start server (foreground, --daemon backgrounds)
  stop                                              Stop daemon server
  restart [--daemon]                                Restart server
  status                                            Show PID, port, uptime
  logs [-f|--follow] [-n N]                         Tail log file
  doctor                                            Check env, build, db, port
  update [TAG] [options]                            Update or switch release version
  version                                           Print version
  help                                              Show this help

Update options:
  --latest                Install the latest stable release (default)
  --version TAG           Install a specific release tag (e.g. v1.1.0)
  --list                  List available release tags from GitHub
  --select                Interactively pick a version from available tags
  --check                 Check if a newer release is available
  --force                 Reinstall even if already on the target version

Options:
  --port PORT   Override PORT env (default 3000)
  --host HOST   Bind host (default 0.0.0.0)
  -d, --daemon  Run in background (writes PID + logs)
  --env FILE    Load env file before start

Examples:
  uni start                 # foreground :3000
  uni start --daemon --port 4000
  uni stop
  uni logs -f
  uni doctor
  uni update                # install latest release
  uni update --list         # show all release tags
  uni update --select       # choose a version interactively
  uni update --version v1.1.0
`.trim());
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let cmd = args[0] ?? "help";
  if (cmd === "uniroute") cmd = args[1] ?? "help";
  const rest = cmd === args[0] ? args.slice(1) : args.slice(2);
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--daemon" || a === "-d") flags.daemon = true;
    else if (a === "--follow" || a === "-f") flags.follow = true;
    else if (a === "--daemon-child") flags.daemonChild = true;
    else if (a === "--check") flags.check = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--list") flags.list = true;
    else if (a === "--select") flags.select = true;
    else if (a === "--latest") flags.latest = true;
    else if (a === "--version" && rest[i + 1]) { flags.version = rest[++i]; }
    else if (a.startsWith("--version=")) flags.version = a.split("=")[1];
    else if (a === "--port" && rest[i + 1]) { flags.port = rest[++i]; }
    else if (a.startsWith("--port=")) flags.port = a.split("=")[1];
    else if (a === "--host" && rest[i + 1]) { flags.host = rest[++i]; }
    else if (a.startsWith("--host=")) flags.host = a.split("=")[1];
    else if (a === "--env" && rest[i + 1]) { flags.env = rest[++i]; }
    else if (a.startsWith("--env=")) flags.env = a.split("=")[1];
    else if (a === "-n" && rest[i + 1]) { flags.n = rest[++i]; }
    else if (a.startsWith("-n")) flags.n = a.slice(2) || rest[++i];
    else if (a === "--help" || a === "-h") flags.help = true;
    else if (!a.startsWith("-")) positionals.push(a);
    else flags[a.replace(/^--/, "")] = true;
  }
  return { cmd, flags, positionals, raw: args };
}

function loadEnvFile(file: string) {
  try {
    const raw = fs.readFileSync(path.resolve(file), "utf8");
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const eq = s.indexOf("=");
      if (eq === -1) continue;
      const k = s.slice(0, eq).trim();
      let v = s.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch (e) {
    console.error(`[uni] cannot load env file ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function cmdStart(flags: Record<string, string | boolean>) {
  if (flags.env) loadEnvFile(String(flags.env));
  if (flags.port) process.env.PORT = String(flags.port);
  if (flags.host) process.env.HOST = String(flags.host);

  const pidPath = getPidPath();
  const logPath = getLogPath();

  if (flags.daemon && !flags.daemonChild) {
    const existing = readPid(pidPath);
    if (existing && isAlive(existing)) {
      console.error(`[uni] already running (pid ${existing}, ${pidPath}) - stop first`);
      process.exit(1);
    }
    const execPath = process.execPath;
    const compiled = isCompiledBinary();
    const bundleDir = detectBundleDir();
    const entryScript = bundleDir
      ? path.join(bundleDir, "uni.mjs")
      : path.resolve(moduleDir, "uni.ts");
    const spawnCmd = execPath;
    const spawnArgs = compiled
      ? ["start", "--daemon-child"]
      : [entryScript, "start", "--daemon-child"];
    if (flags.port) spawnArgs.push("--port", String(flags.port));
    if (flags.host) spawnArgs.push("--host", String(flags.host));
    if (flags.env) spawnArgs.push("--env", String(flags.env));

    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = fs.openSync(logPath, "a");
    const child = spawn(spawnCmd, spawnArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
    fs.closeSync(logFd);

    for (let i = 0; i < 20; i++) {
      await sleepMs(200);
      const pid = readPid(pidPath);
      if (pid && isAlive(pid)) {
        console.log(`[uni] started in background pid ${pid} (log: ${logPath}, pid: ${pidPath})`);
        process.exit(0);
      }
      if (child.exitCode !== null && child.exitCode !== 0) {
        console.error(`[uni] daemon failed to start (exit ${child.exitCode}), see ${logPath}`);
        process.exit(1);
      }
    }
    console.error(`[uni] daemon start timeout - check ${logPath} and ${pidPath}`);
    process.exit(1);
  }

  const port = flags.port ? Number(flags.port) : undefined;
  const hostname = flags.host ? String(flags.host) : undefined;

  const myPid = process.pid;
  try {
    writePid(myPid, pidPath);
    console.log(`[uni] pid ${myPid} -> ${pidPath}`);
    if (flags.daemonChild) console.log(`[uni] logging to ${logPath}`);
  } catch (e) {
    console.warn(`[uni] cannot write pid file ${pidPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const cleanup = () => {
    const cur = readPid(pidPath);
    if (cur === myPid) removePid(pidPath);
  };
  process.on("exit", cleanup);

  // Dynamic import keeps non-start commands from loading the server bundle.
  const { startServer } = await import("../server");
  const server = startServer({ port, hostname, onShutdown: cleanup });
  console.log(`[uni] running ${flags.daemonChild ? "(daemon)" : "(foreground)"} - press Ctrl+C to stop / uni stop`);
  void server;
}

function cmdStop() {
  const pidPath = getPidPath();
  const pid = readPid(pidPath);
  if (!pid) {
    console.error(`[uni] not running (no pid file at ${pidPath})`);
    process.exit(1);
  }
  if (!isAlive(pid)) {
    console.error(`[uni] stale pid ${pid} - removing ${pidPath}`);
    removePid(pidPath);
    process.exit(0);
  }
  console.log(`[uni] stopping pid ${pid}...`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    console.error(`[uni] kill failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const start = Date.now();
  const iv = setInterval(() => {
    if (!isAlive(pid) || Date.now() - start > 5000) {
      clearInterval(iv);
      if (!isAlive(pid)) {
        removePid(pidPath);
        console.log("[uni] stopped");
        process.exit(0);
      } else {
        console.log("[uni] SIGTERM timeout, sending SIGKILL...");
        try { process.kill(pid, "SIGKILL"); } catch {}
        setTimeout(() => {
          if (!isAlive(pid)) removePid(pidPath);
          console.log(isAlive(pid) ? "[uni] still alive" : "[uni] killed");
          process.exit(isAlive(pid) ? 1 : 0);
        }, 1000);
      }
    }
  }, 200);
}

async function cmdRestart(flags: Record<string, string | boolean>) {
  const pidPath = getPidPath();
  const pid = readPid(pidPath);
  if (pid && isAlive(pid)) {
    console.log(`[uni] restarting (stop pid ${pid})...`);
    try { process.kill(pid, "SIGTERM"); } catch {}
    for (let i = 0; i < 25; i++) {
      await sleepMs(200);
      if (!isAlive(pid)) break;
    }
    if (isAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
      await sleepMs(500);
    }
    removePid(pidPath);
  } else if (pid) removePid(pidPath);
  await cmdStart(flags);
}

function cmdStatus() {
  const pidPath = getPidPath();
  const logPath = getLogPath();
  const pid = readPid(pidPath);
  if (!pid) {
    console.log(`[uni] not running (no pid file at ${pidPath})`);
    console.log(`  log: ${logPath}`);
    process.exit(1);
  }
  const alive = isAlive(pid);
  console.log(`pid: ${pid} @ ${pidPath} - ${alive ? "alive" : "stale (not running)"}`);
  console.log(`log: ${logPath}`);
  if (alive) {
    try {
      const stat = fs.statSync(`/proc/${pid}`);
      const uptimeSec = Math.floor((Date.now() - stat.mtimeMs) / 1000);
      console.log(`uptime: ~${uptimeSec}s`);
    } catch {}
    const port = process.env.PORT ?? "3000";
    console.log(`port: ${port} (PORT env)`);
  } else {
    process.exit(1);
  }
}

function readLastLines(filePath: string, lineCount: number): string {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-Math.max(1, lineCount)).join("\n") + (lines.length ? "\n" : "");
}

function cmdLogs(flags: Record<string, string | boolean>) {
  const logPath = getLogPath();
  if (!fs.existsSync(logPath)) {
    console.error(`[uni] no log file at ${logPath} - start with --daemon first`);
    process.exit(1);
  }
  const n = flags.n ? Number(flags.n) : 100;
  const follow = !!flags.follow;
  if (follow) {
    console.log(`[uni] following ${logPath} (Ctrl+C to exit)`);
    if (process.platform !== "win32") {
      const proc = spawn("tail", ["-F", "-n", String(n), logPath], { stdio: "inherit" });
      process.on("SIGINT", () => { proc.kill(); process.exit(0); });
      return;
    }
    process.stdout.write(readLastLines(logPath, n));
    let offset = fs.statSync(logPath).size;
    const iv = setInterval(() => {
      try {
        const size = fs.statSync(logPath).size;
        if (size > offset) {
          const fd = fs.openSync(logPath, "r");
          const buf = Buffer.allocUnsafe(size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          fs.closeSync(fd);
          offset = size;
          process.stdout.write(buf.toString("utf8"));
        } else if (size < offset) {
          offset = size;
        }
      } catch {
        // ignore transient rotation errors
      }
    }, 300);
    process.on("SIGINT", () => { clearInterval(iv); process.exit(0); });
  } else {
    if (process.platform !== "win32") {
      const proc = spawnSync("tail", ["-n", String(n), logPath], { encoding: "utf8" });
      if (proc.status === 0) {
        process.stdout.write(proc.stdout ?? "");
        if (proc.stderr) process.stderr.write(proc.stderr);
        return;
      }
    }
    process.stdout.write(readLastLines(logPath, n));
  }
}

async function cmdDoctor() {
  const { ok, checks } = await runDoctor();
  for (const c of checks) {
    const icon = c.ok ? "✓" : "✗";
    console.log(`${icon} ${c.name}: ${c.msg}`);
  }
  console.log(ok ? "\n[uni] doctor: ok" : "\n[uni] doctor: issues found - see above");
  process.exit(ok ? 0 : 1);
}

function askLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

function createCliProgressPrinter() {
  let lastDraw = 0;
  const isTty = Boolean(process.stdout.isTTY);
  return (ev: UpdateProgressEvent) => {
    if (ev.status !== "downloading") return;
    const mb = (ev.bytesDownloaded / (1024 * 1024)).toFixed(2);
    const done = ev.percent === 100;
    const now = Date.now();
    if (!done && now - lastDraw < 100) return;
    lastDraw = now;
    if (ev.totalBytes && ev.totalBytes > 0) {
      const pct = Math.min(100, ev.percent ?? Math.round((ev.bytesDownloaded / ev.totalBytes) * 100));
      const totalMb = (ev.totalBytes / (1024 * 1024)).toFixed(2);
      const width = 24;
      const filled = Math.round((pct / 100) * width);
      const bar =
        "=".repeat(filled) +
        (filled < width ? ">" : "") +
        " ".repeat(Math.max(0, width - filled - (filled < width ? 1 : 0)));
      if (isTty) {
        process.stdout.write(`\r  [${bar}] ${String(pct).padStart(3)}% ${mb}/${totalMb} MB${done ? "\n" : ""}`);
      } else if (done) {
        console.log(`  downloaded ${mb}/${totalMb} MB (100%)`);
      }
    } else if (isTty) {
      process.stdout.write(`\r  downloaded ${mb} MB${done ? "\n" : ""}`);
    } else if (done) {
      console.log(`  downloaded ${mb} MB`);
    }
  };
}

async function cmdUpdate(flags: Record<string, string | boolean>, positionals: string[]) {
  const compiled = isCompiledBinary();
  const bundleDir = detectBundleDir();
  const repo = process.env.UNIROUTE_REPO ?? process.env.REPO ?? "mygcp/uniroute";

  console.log(`[uni] current ${VERSION} (${compiled ? "binary" : bundleDir ? "bundle" : "source"}) - checking ${repo}...`);

  let catalog;
  try {
    catalog = await listGitHubReleases({ forceRefresh: true, repo });
  } catch (e) {
    console.error(`[uni] update: failed to fetch releases: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  if (flags.list) {
    if (catalog.releases.length === 0) {
      console.log("[uni] no releases published yet.");
      process.exit(0);
    }
    console.log(`\nAvailable releases for ${catalog.repo}:`);
    for (const r of catalog.releases) {
      const tags: string[] = [];
      if (r.isCurrent) tags.push("current");
      if (r.isLatest) tags.push("latest");
      if (r.prerelease) tags.push("prerelease");
      const date = r.publishedAt ? r.publishedAt.slice(0, 10) : "unknown-date";
      const assets = [
        r.hasBundleAsset ? "bundle" : null,
        r.hasBinaryAsset ? "binary" : null,
      ]
        .filter(Boolean)
        .join("+");
      console.log(
        `  ${r.tag.padEnd(14)} ${date}  [${assets || "source-only"}]${tags.length ? `  (${tags.join(", ")})` : ""}`,
      );
    }
    process.exit(0);
  }

  if (flags.check) {
    const latest = catalog.latestTag ?? "unknown";
    const latestVer = latest.replace(/^v/i, "");
    console.log(`[uni] latest ${latest} (current ${VERSION})`);
    if (latestVer === VERSION) {
      console.log("[uni] already up to date");
    } else {
      console.log(`[uni] update available: ${VERSION} -> ${latest}`);
    }
    process.exit(0);
  }

  if (!compiled && !bundleDir) {
    console.log("[uni] update: running from a local source checkout.");
    console.log("  Use git to switch versions: git fetch --tags && git checkout <tag> && bun install && bun run build");
    process.exit(0);
  }

  let target = typeof flags.version === "string"
    ? flags.version
    : positionals[0]
      ? positionals[0]
      : "latest";

  if (flags.latest) target = "latest";

  if (flags.select) {
    if (!process.stdin.isTTY) {
      console.error("[uni] --select requires an interactive terminal.");
      process.exit(1);
    }
    if (catalog.releases.length === 0) {
      console.error("[uni] no releases available to select.");
      process.exit(1);
    }
    console.log("\nSelect a release to install:");
    console.log(`  0) latest (${catalog.latestTag ?? "latest"})`);
    catalog.releases.forEach((r, idx) => {
      const marks = [
        r.isCurrent ? "current" : null,
        r.isLatest ? "latest" : null,
        r.prerelease ? "prerelease" : null,
      ]
        .filter(Boolean)
        .join(", ");
      const date = r.publishedAt ? r.publishedAt.slice(0, 10) : "";
      console.log(`  ${idx + 1}) ${r.tag}${date ? ` (${date})` : ""}${marks ? ` [${marks}]` : ""}`);
    });
    const choice = await askLine("\nEnter number (0 for latest, or q to cancel): ");
    if (!choice || choice.toLowerCase() === "q") {
      console.log("[uni] update cancelled");
      process.exit(0);
    }
    const num = Number(choice);
    if (!Number.isInteger(num) || num < 0 || num > catalog.releases.length) {
      console.error(`[uni] invalid selection: ${choice}`);
      process.exit(1);
    }
    target = num === 0 ? "latest" : catalog.releases[num - 1].tag;
  }

  try {
    const result = await applyAppUpdate({
      target,
      force: Boolean(flags.force),
      repo,
      onProgress: createCliProgressPrinter(),
    });
    if (result.alreadyUpToDate) {
      console.log(`[uni] already on ${result.tag} (pass --force to reinstall)`);
      process.exit(0);
    }
    console.log(`[uni] updated (${result.mode}) ${result.fromVersion} -> ${result.toVersion} (${result.tag})`);
    console.log("  restart if running: uni restart --daemon");
    console.log("  verify: uni doctor && uni version");
  } catch (e) {
    console.error(`[uni] update failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

export async function main() {
  const { cmd, flags, positionals } = parseArgs(process.argv);
  if (flags.help) { printHelp(); process.exit(0); }
  switch (cmd) {
    case "start": await cmdStart(flags); break;
    case "stop": cmdStop(); break;
    case "restart": await cmdRestart(flags); break;
    case "status": cmdStatus(); break;
    case "logs": cmdLogs(flags); break;
    case "doctor": await cmdDoctor(); break;
    case "update": await cmdUpdate(flags, positionals); break;
    case "version":
    case "--version":
    case "-v": console.log(`uni ${VERSION}`); break;
    case "help":
    case "--help":
    case "-h": printHelp(); break;
    default:
      console.error(`[uni] unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`[uni] fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
