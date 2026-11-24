import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export function getPidPath(): string {
  if (process.env.UNIROUTE_PID_FILE) return path.resolve(process.env.UNIROUTE_PID_FILE);
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return path.join(xdg, "uniroute", "uniroute.pid");
  const cwdPid = path.resolve(process.cwd(), "data", "uniroute.pid");
  const homePid = path.join(os.homedir(), ".local", "share", "uniroute", "uniroute.pid");
  try {
    const dataDir = path.dirname(cwdPid);
    if (fs.existsSync(dataDir)) return cwdPid;
  } catch {}
  return homePid;
}

export function getLogPath(): string {
  if (process.env.UNIROUTE_LOG_FILE) return path.resolve(process.env.UNIROUTE_LOG_FILE);
  const pidPath = getPidPath();
  const dir = path.dirname(pidPath);
  if (dir.endsWith("data") || dir.includes("data")) {
    return path.join(path.dirname(pidPath), "logs", "uniroute.log");
  }
  return path.join(dir, "uniroute.log");
}

export function readPid(pidPath?: string): number | null {
  const p = pidPath ?? getPidPath();
  try {
    const raw = fs.readFileSync(p, "utf8").trim();
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  } catch {
    return null;
  }
}

export function writePid(pid: number, pidPath?: string): void {
  const p = pidPath ?? getPidPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(pid) + "\n", { mode: 0o600 });
}

export function removePid(pidPath?: string): void {
  const p = pidPath ?? getPidPath();
  try {
    fs.unlinkSync(p);
  } catch {}
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
