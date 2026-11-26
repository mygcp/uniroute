#!/usr/bin/env bun
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import pkg from "../package.json";
import { getPidPath, getLogPath, readPid, writePid, removePid, isAlive } from "./pid";
import { runDoctor } from "./doctor";

const VERSION = pkg.version || "1.0.0";

function isCompiledBinary(): boolean {
  const dir = import.meta.dir ?? "";
  if (dir.startsWith("/$bunfs") || /^[A-Za-z]:[\\/]+~BUN/i.test(dir)) return true;
  const bin = path.basename(process.execPath).replace(/\.exe$/i, "").toLowerCase();
  return bin !== "bun" && bin !== "node";
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
  update [--check] [--force]                        Self-update binary from GitHub Releases
  version                                           Print version
  help                                              Show this help

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
  uni update                # download latest binary
  uni update --check        # only check version
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
    const spawnCmd = execPath;
    const spawnArgs = compiled
      ? ["start", "--daemon-child"]
      : [path.resolve(import.meta.dir, "uni.ts"), "start", "--daemon-child"];
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
      await Bun.sleep(200);
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
      await Bun.sleep(200);
      if (!isAlive(pid)) break;
    }
    if (isAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
      await Bun.sleep(500);
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
    const proc = Bun.spawn(["tail", "-F", "-n", String(n), logPath], { stdout: "inherit", stderr: "inherit" });
    process.on("SIGINT", () => { proc.kill(); process.exit(0); });
  } else {
    const proc = Bun.spawnSync(["tail", "-n", String(n), logPath]);
    process.stdout.write(proc.stdout.toString());
    if (proc.stderr.length) process.stderr.write(proc.stderr.toString());
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

function getUpdateTarget(): { target: string; artifact: string; ext: string } | null {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "linux" && arch === "x64") return { target: "bun-linux-x64", artifact: "uni-linux-x64", ext: "" };
  if (platform === "linux" && arch === "arm64") return { target: "bun-linux-arm64", artifact: "uni-linux-arm64", ext: "" };
  if (platform === "darwin" && arch === "x64") return { target: "bun-darwin-x64", artifact: "uni-darwin-x64", ext: "" };
  if (platform === "darwin" && arch === "arm64") return { target: "bun-darwin-arm64", artifact: "uni-darwin-arm64", ext: "" };
  if (platform === "win32") return { target: "bun-windows-x64", artifact: "uni-windows-x64.exe", ext: ".exe" };
  return null;
}

async function cmdUpdate(flags: Record<string, string | boolean>) {
  const repo = process.env.UNIROUTE_REPO ?? process.env.REPO ?? "mygcp/uniroute";
  const compiled = isCompiledBinary();
  if (!compiled) {
    console.log("[uni] update: running via bun (dev) - self-update only for compiled binary");
    console.log("  try: git pull && bun run build");
    if (!flags.force) process.exit(0);
  }

  const current = VERSION;
  console.log(`[uni] current ${current} - checking ${repo}...`);

  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  let latest: { tag_name: string; assets: Array<{ name: string; browser_download_url: string }> };
  try {
    const res = await fetch(apiUrl, { headers: { Accept: "application/vnd.github+json", "User-Agent": "uni-update" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
    latest = (await res.json()) as typeof latest;
  } catch (e) {
    console.error(`[uni] update: failed to fetch latest: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const tag = latest.tag_name;
  const latestVer = tag.replace(/^v/, "");
  console.log(`[uni] latest ${tag} (current ${current})`);

  if (latestVer === current && !flags.force) {
    console.log("[uni] already up to date");
    process.exit(0);
  }
  if (flags.check) {
    console.log(`[uni] update available: ${current} -> ${latestVer}`);
    process.exit(0);
  }

  const tgt = getUpdateTarget();
  if (!tgt) {
    console.error(`[uni] update: unsupported platform ${process.platform}/${process.arch}`);
    process.exit(1);
  }

  const asset = latest.assets.find((a) => a.name === tgt.artifact) ?? latest.assets.find((a) => a.name === `${tgt.artifact}.tar.gz`);
  if (!asset) {
    console.error(`[uni] update: asset ${tgt.artifact} not found in ${tag}`);
    console.error(`  available: ${latest.assets.map((a) => a.name).join(", ")}`);
    process.exit(1);
  }

  const url = asset.browser_download_url;
  console.log(`[uni] downloading ${asset.name} from ${url}...`);

  const tmp = path.join(osTmpDir(), `uni-update-${Date.now()}-${tgt.artifact}`);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) {
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(tmp, buf, { mode: 0o755 });
    } else {
      const total = Number(res.headers.get("content-length") ?? 0) || 0;
      const ws = fs.createWriteStream(tmp, { mode: 0o755 });
      const reader = res.body.getReader();
      let received = 0;
      let lastDraw = 0;
      const isTty = Boolean(process.stdout.isTTY);
      const drawBar = (done = false) => {
        const mb = (received / (1024 * 1024)).toFixed(1);
        if (total > 0) {
          const pct = Math.min(100, Math.round((received / total) * 100));
          const totalMb = (total / (1024 * 1024)).toFixed(1);
          const width = 24;
          const filled = Math.round((pct / 100) * width);
          const bar = "=".repeat(filled) + (filled < width ? ">" : "") + " ".repeat(Math.max(0, width - filled - (filled < width ? 1 : 0)));
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
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          received += value.byteLength;
          if (!ws.write(value)) {
            await new Promise<void>((resolve) => ws.once("drain", resolve));
          }
          const now = Date.now();
          if (now - lastDraw >= 100) {
            lastDraw = now;
            drawBar(false);
          }
        }
        await new Promise<void>((resolve, reject) => {
          ws.on("error", reject);
          ws.end(() => resolve());
        });
        drawBar(true);
      } catch (err) {
        try {
          ws.destroy();
        } catch {}
        throw err;
      }
    }
  } catch (e) {
    console.error(`[uni] download failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  let newBinary = tmp;
  if (asset.name.endsWith(".tar.gz")) {
    try {
      const outDir = `${tmp}.dir`;
      fs.mkdirSync(outDir, { recursive: true });
      const proc = Bun.spawnSync(["tar", "-xzf", tmp, "-C", outDir]);
      if (proc.exitCode !== 0) throw new Error(proc.stderr.toString().slice(0, 300));
      const found = fs.readdirSync(outDir, { recursive: true } as any) as unknown as string[];
      const binName = tgt.artifact;
      const candidate = found.find((p) => String(p).endsWith(binName)) ?? found.find((p) => String(p).includes("uni-"));
      if (!candidate) throw new Error("binary not found in tar");
      const src = path.join(outDir, String(candidate));
      const extracted = `${tmp}.bin`;
      fs.copyFileSync(src, extracted);
      fs.chmodSync(extracted, 0o755);
      newBinary = extracted;
    } catch (e) {
      console.error(`[uni] extract failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }

  let targetPath = process.execPath;
  if (!compiled) {
    const homeBin = path.join(os.homedir(), ".local", "bin", "uni");
    const usrBin = "/usr/local/bin/uni";
    if (fs.existsSync(homeBin)) targetPath = homeBin;
    else if (fs.existsSync(usrBin) && (() => { try { fs.accessSync(path.dirname(usrBin), fs.constants.W_OK); return true; } catch { return false; } })()) targetPath = usrBin;
    else {
      console.log(`[uni] dev mode - new binary at ${newBinary}, copy manually to ~/.local/bin/uni`);
      console.log(`  mv ${newBinary} ~/.local/bin/uni && chmod +x ~/.local/bin/uni`);
      process.exit(0);
    }
  }

  try {
    const bak = `${targetPath}.bak`;
    try { fs.copyFileSync(targetPath, bak); } catch {}
    fs.copyFileSync(newBinary, targetPath);
    fs.chmodSync(targetPath, 0o755);
    console.log(`[uni] updated ${targetPath} ${current} -> ${latestVer}`);
    console.log("  run: uni doctor && uni version");
  } catch (e) {
    console.error(`[uni] replace failed (need sudo?): ${e instanceof Error ? e.message : String(e)}`);
    console.error(`  new binary kept at ${newBinary}`);
    process.exit(1);
  }
}

function osTmpDir(): string {
  return process.env.TMPDIR ?? process.env.TMP ?? os.tmpdir();
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv);
  if (flags.help) { printHelp(); process.exit(0); }
  switch (cmd) {
    case "start": await cmdStart(flags); break;
    case "stop": cmdStop(); break;
    case "restart": await cmdRestart(flags); break;
    case "status": cmdStatus(); break;
    case "logs": cmdLogs(flags); break;
    case "doctor": await cmdDoctor(); break;
    case "update": await cmdUpdate(flags); break;
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
