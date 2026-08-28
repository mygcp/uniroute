#!/usr/bin/env bun
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { getPidPath, getLogPath, readPid, writePid, removePid, isAlive } from "./pid";
import { runDoctor } from "./doctor";

const VERSION = (() => {
  try {
    // try embedded import first (bundled), then filesystem
    // @ts-ignore — package.json is bundled at compile time
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../package.json"), "utf8"));
    if (pkg.version) return pkg.version;
  } catch {}
  // fallback hardcoded — keep in sync with package.json
  return "1.0.0";
})();

function printHelp() {
  console.log(`
UniRoute — self-hosted AI gateway

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
  // alias: uniroute -> uni
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

  // daemon mode: spawn child detached
  if (flags.daemon && !flags.daemonChild) {
    const existing = readPid(pidPath);
    if (existing && isAlive(existing)) {
      console.error(`[uni] already running (pid ${existing}, ${pidPath}) — stop first`);
      process.exit(1);
    }
    // build spawn args: re-invoke same binary without --daemon, add --daemon-child
    const execPath = process.execPath;
    const isBun = execPath.includes("bun");
    let spawnCmd: string;
    let spawnArgs: string[];
    if (isBun) {
      // bun cli/uni.ts start --daemon-child --port ...
      const script = path.resolve(import.meta.dir, "uni.ts");
      spawnCmd = execPath;
      spawnArgs = [script, "start", "--daemon-child"];
      if (flags.port) spawnArgs.push("--port", String(flags.port));
      if (flags.host) spawnArgs.push("--host", String(flags.host));
      if (flags.env) spawnArgs.push("--env", String(flags.env));
    } else {
      // compiled binary: uni start --daemon-child
      spawnCmd = execPath;
      spawnArgs = ["start", "--daemon-child"];
      if (flags.port) spawnArgs.push("--port", String(flags.port));
      if (flags.host) spawnArgs.push("--host", String(flags.host));
      if (flags.env) spawnArgs.push("--env", String(flags.env));
    }

    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = fs.openSync(logPath, "a");
    const child = spawn(spawnCmd, spawnArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    // allow parent to exit independent of child
    child.unref();
    fs.closeSync(logFd);

    // wait briefly for pid file
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
    console.error(`[uni] daemon start timeout — check ${logPath} and ${pidPath}`);
    process.exit(1);
  }

  // foreground or daemon-child: actually start server
  const port = flags.port ? Number(flags.port) : undefined;
  const hostname = flags.host ? String(flags.host) : undefined;

  // write pid file (for both foreground and daemon-child)
  const myPid = process.pid;
  try {
    writePid(myPid, pidPath);
    console.log(`[uni] pid ${myPid} → ${pidPath}`);
    if (flags.daemonChild) console.log(`[uni] logging to ${logPath}`);
  } catch (e) {
    console.warn(`[uni] cannot write pid file ${pidPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ensure pid removed on exit
  const cleanup = () => {
    const cur = readPid(pidPath);
    if (cur === myPid) removePid(pidPath);
  };
  process.on("exit", cleanup);
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });

  // dynamic import server (avoid bundling issues when running via bun)
  const { startServer } = await import("../server");
  const server = startServer({ port, hostname });
  // keep process alive — Bun.serve keeps event loop
  console.log(`[uni] running ${flags.daemonChild ? "(daemon)" : "(foreground)"} — press Ctrl+C to stop / uni stop`);
  // prevent exit: keep reference
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
    console.error(`[uni] stale pid ${pid} — removing ${pidPath}`);
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
  // wait up to 5s
  const start = Date.now();
  const iv = setInterval(() => {
    if (!isAlive(pid) || Date.now() - start > 5000) {
      clearInterval(iv);
      if (!isAlive(pid)) {
        removePid(pidPath);
        console.log(`[uni] stopped`);
        process.exit(0);
      } else {
        console.log(`[uni] SIGTERM timeout, sending SIGKILL...`);
        try { process.kill(pid, "SIGKILL"); } catch {}
        setTimeout(() => {
          if (!isAlive(pid)) removePid(pidPath);
          console.log(isAlive(pid) ? `[uni] still alive` : `[uni] killed`);
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
  // start again
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
  console.log(`pid: ${pid} @ ${pidPath} — ${alive ? "alive" : "stale (not running)"}`);
  console.log(`log: ${logPath}`);
  if (alive) {
    try {
      const stat = fs.statSync(`/proc/${pid}` as string);
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
    console.error(`[uni] no log file at ${logPath} — start with --daemon first`);
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
  console.log(ok ? "\n[uni] doctor: ok" : "\n[uni] doctor: issues found — see above");
  process.exit(ok ? 0 : 1);
}

function getUpdateTarget(): { target: string; artifact: string; ext: string } | null {
  const os = process.platform; // linux, darwin, win32
  const arch = process.arch; // x64, arm64
  if (os === "linux" && arch === "x64") return { target: "bun-linux-x64", artifact: "uni-linux-x64", ext: "" };
  if (os === "linux" && arch === "arm64") return { target: "bun-linux-arm64", artifact: "uni-linux-arm64", ext: "" };
  if (os === "darwin" && arch === "x64") return { target: "bun-darwin-x64", artifact: "uni-darwin-x64", ext: "" };
  if (os === "darwin" && arch === "arm64") return { target: "bun-darwin-arm64", artifact: "uni-darwin-arm64", ext: "" };
  if (os === "win32") return { target: "bun-windows-x64", artifact: "uni-windows-x64.exe", ext: ".exe" };
  return null;
}

async function cmdUpdate(flags: Record<string, string | boolean>) {
  const repo = process.env.UNIROUTE_REPO ?? process.env.REPO ?? "mygcp/uniroute";
  const isCompiled = !process.execPath.includes("bun");
  if (!isCompiled) {
    console.log(`[uni] update: running via bun (dev) — self-update only for compiled binary`);
    console.log(`  try: git pull && bun run build`);
    if (!flags.force) process.exit(0);
  }

  const current = VERSION;
  console.log(`[uni] current ${current} — checking ${repo}...`);

  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  let latest: { tag_name: string; assets: Array<{ name: string; browser_download_url: string }> };
  try {
    const res = await fetch(apiUrl, { headers: { "Accept": "application/vnd.github+json", "User-Agent": "uni-update" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
    latest = (await res.json()) as typeof latest;
  } catch (e) {
    console.error(`[uni] update: failed to fetch latest: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const tag = latest.tag_name; // e.g. v1.1.0
  const latestVer = tag.replace(/^v/, "");
  console.log(`[uni] latest ${tag} (current ${current})`);

  if (latestVer === current && !flags.force) {
    console.log(`[uni] already up to date`);
    if (flags.check) process.exit(0);
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

  // prefer bare binary asset (uni-linux-x64) over tar.gz for self-update
  const asset = latest.assets.find((a) => a.name === tgt.artifact) ?? latest.assets.find((a) => a.name === `${tgt.artifact}.tar.gz`);
  if (!asset) {
    console.error(`[uni] update: asset ${tgt.artifact} not found in ${tag}`);
    console.error(`  available: ${latest.assets.map((a) => a.name).join(", ")}`);
    process.exit(1);
  }

  const url = asset.browser_download_url;
  console.log(`[uni] downloading ${asset.name} from ${url}...`);

  const tmp = path.join(osTmpDir(), `uni-update-${Date.now()}-${tgt.artifact}`);
  // download
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmp, buf, { mode: 0o755 });
  } catch (e) {
    console.error(`[uni] download failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  let newBinary = tmp;
  // if tar.gz, extract binary inside
  if (asset.name.endsWith(".tar.gz")) {
    try {
      const outDir = `${tmp}.dir`;
      fs.mkdirSync(outDir, { recursive: true });
      const proc = Bun.spawnSync(["tar", "-xzf", tmp, "-C", outDir]);
      if (proc.exitCode !== 0) throw new Error(proc.stderr.toString().slice(0, 300));
      // find uni binary inside
      const found = fs.readdirSync(outDir, { recursive: true } as any) as unknown as string[];
      const binName = tgt.artifact;
      const candidate = (found as string[]).find((p) => String(p).endsWith(binName)) ?? found.find((p) => String(p).includes("uni-"));
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

  const dest = process.execPath;
  // safety: if dest is bun, use ~/.local/bin/uni
  let targetPath = dest;
  if (dest.includes("bun")) {
    const homeBin = path.join(os.homedir(), ".local", "bin", "uni");
    const usrBin = "/usr/local/bin/uni";
    if (fs.existsSync(homeBin)) targetPath = homeBin;
    else if (fs.existsSync(usrBin) && (()=>{ try{ fs.accessSync(path.dirname(usrBin), fs.constants.W_OK); return true;}catch{return false}})()) targetPath = usrBin;
    else {
      console.log(`[uni] dev mode — new binary at ${newBinary}, copy manually to ~/.local/bin/uni`);
      console.log(`  mv ${newBinary} ~/.local/bin/uni && chmod +x ~/.local/bin/uni`);
      process.exit(0);
    }
  }

  try {
    // backup
    const bak = `${targetPath}.bak`;
    try { fs.copyFileSync(targetPath, bak); } catch {}
    fs.copyFileSync(newBinary, targetPath);
    fs.chmodSync(targetPath, 0o755);
    console.log(`[uni] updated ${targetPath} ${current} -> ${latestVer} ✓`);
    console.log(`  run: uni doctor && uni version`);
  } catch (e) {
    console.error(`[uni] replace failed (need sudo?): ${e instanceof Error ? e.message : String(e)}`);
    console.error(`  new binary kept at ${newBinary}`);
    process.exit(1);
  }
}

function osTmpDir(): string {
  return process.env.TMPDIR ?? process.env.TMP ?? "/tmp";
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
