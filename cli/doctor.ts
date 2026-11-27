import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { probeEphemeralPort } from "../app/.server/http-runtime";

type Check = { name: string; ok: boolean; msg: string };

const moduleDir =
  typeof import.meta.dir === "string"
    ? import.meta.dir
    : path.dirname(fileURLToPath(import.meta.url));

function isCompiledBinary(): boolean {
  const dir = import.meta.dir ?? "";
  if (dir.startsWith("/$bunfs") || /^[A-Za-z]:[\\/]+~BUN/i.test(dir)) return true;
  const bin = path.basename(process.execPath).replace(/\.exe$/i, "").toLowerCase();
  return bin !== "bun" && bin !== "node";
}

function isBundleMode(): boolean {
  if (process.env.UNIROUTE_INSTALL_MODE === "bundle") return true;
  return fs.existsSync(path.join(moduleDir, "client", "favicon.ico")) ||
    fs.existsSync(path.join(moduleDir, "client", "assets"));
}

export async function runDoctor(): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];

  const isBun = typeof Bun !== "undefined";
  const bunVer = isBun ? Bun.version : (process.versions.bun ?? null);
  const nodeVer = process.versions.node ?? null;
  if (bunVer) {
    checks.push({
      name: "runtime",
      ok: true,
      msg: `Bun ${bunVer} (need >=1.2)`,
    });
  } else if (nodeVer) {
    const [maj, min] = nodeVer.split(".").map(Number);
    const ok = maj > 22 || (maj === 22 && min >= 5);
    checks.push({
      name: "runtime",
      ok,
      msg: `Node.js ${nodeVer} (need >=22.5)`,
    });
  } else {
    checks.push({ name: "runtime", ok: false, msg: "unknown runtime" });
  }

  if (isCompiledBinary()) {
    const embeddedCount = isBun && Array.isArray(Bun.embeddedFiles) ? Bun.embeddedFiles.length : 0;
    checks.push({
      name: "build",
      ok: true,
      msg: embeddedCount > 0 ? `embedded in binary (${embeddedCount} client assets)` : "embedded in binary",
    });
  } else if (isBundleMode()) {
    const appDir = process.env.UNIROUTE_APP_DIR ?? moduleDir;
    const hasClient =
      fs.existsSync(path.join(appDir, "client", "assets")) ||
      fs.existsSync(path.join(appDir, "client", "favicon.ico"));
    checks.push({
      name: "build",
      ok: hasClient,
      msg: hasClient ? `prebuilt bundle (${appDir})` : `client assets missing in ${appDir}`,
    });
  } else {
    const candidates = [
      path.resolve(process.cwd(), "build/server/index.js"),
      path.resolve(path.dirname(process.execPath), "build/server/index.js"),
      path.join(moduleDir, "../build/server/index.js"),
    ];
    const buildExists = candidates.some((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    checks.push({
      name: "build",
      ok: buildExists,
      msg: buildExists ? "build/server/index.js found" : "build/server/index.js not found - run 'bun run build'",
    });
  }

  const dbPath = process.env.DATABASE_URL ?? path.resolve(process.cwd(), "data/uniroute.db");
  const dataDir = path.dirname(path.resolve(dbPath));
  let writable = false;
  let wmsg = "";
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK);
    writable = true;
    wmsg = `data dir writable: ${dataDir}`;
  } catch (e) {
    wmsg = `data dir not writable: ${dataDir} - ${e instanceof Error ? e.message : String(e)}`;
  }
  checks.push({ name: "data", ok: writable, msg: wmsg });

  const port = Number(process.env.PORT ?? 3000);
  let portOk = true;
  let portMsg = `PORT ${port} (env PORT or --port)`;
  try {
    const p = await probeEphemeralPort();
    portMsg += ` - probe ok (ephemeral ${p})`;
  } catch (e) {
    portOk = false;
    portMsg += ` - probe failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  checks.push({ name: "port", ok: portOk, msg: portMsg });

  const pw = process.env.PASSWORD;
  if (!pw || pw === "CHANGEME") {
    checks.push({ name: "password", ok: false, msg: "PASSWORD is CHANGEME or unset - change in .env (dashboard login)" });
  } else {
    checks.push({ name: "password", ok: true, msg: "PASSWORD set" });
  }

  try {
    const stat = fs.statfsSync(dataDir);
    const freeMb = Math.floor((stat.bfree * stat.bsize) / 1024 / 1024);
    checks.push({ name: "disk", ok: freeMb > 100, msg: `free ~${freeMb} MB in ${dataDir}` });
  } catch {
    checks.push({ name: "disk", ok: true, msg: "disk check skipped" });
  }

  const pidPath = process.env.UNIROUTE_PID_FILE ?? path.join(os.homedir(), ".local/share/uniroute/uniroute.pid");
  const cwdPid = path.resolve(process.cwd(), "data/uniroute.pid");
  const pidFile = fs.existsSync(cwdPid) ? cwdPid : pidPath;
  let pidMsg = `pid file: ${pidFile}`;
  try {
    if (fs.existsSync(pidFile)) {
      const raw = fs.readFileSync(pidFile, "utf8").trim();
      const pid = Number(raw);
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      pidMsg += alive ? ` (pid ${pid} alive)` : ` (pid ${pid} stale)`;
      checks.push({ name: "pid", ok: true, msg: pidMsg });
    } else {
      checks.push({ name: "pid", ok: true, msg: `${pidMsg} (not running)` });
    }
  } catch (e) {
    checks.push({ name: "pid", ok: false, msg: `${pidMsg} - ${e instanceof Error ? e.message : String(e)}` });
  }

  // Only fail doctor on hard startup requirements.
  const hardOk = checks.filter((c) => ["build", "data"].includes(c.name)).every((c) => c.ok);
  return { ok: hardOk, checks };
}
