import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, rmSync } from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { runEphemeralJob } from "./async-utils";

const UNSAFE_BIN_CHARS = /[\0-\x1f\x7f;&|`$<>]/;

export type DownloadPhase =
  | "idle"
  | "resolving"
  | "downloading"
  | "verifying"
  | "extracting"
  | "done"
  | "error";

export type DownloadProgressState = {
  key: string;
  status: DownloadPhase;
  bytesDownloaded: number;
  totalBytes: number | null;
  percent: number | null;
  assetName?: string;
  message?: string;
  updatedAt: number;
};

const PROGRESS_SYMBOL = Symbol.for("uniroute.downloadProgress");
const gProg = globalThis as Record<symbol, Map<string, DownloadProgressState> | undefined>;
const progressMap: Map<string, DownloadProgressState> =
  gProg[PROGRESS_SYMBOL] ?? (gProg[PROGRESS_SYMBOL] = new Map<string, DownloadProgressState>());

export function setDownloadProgress(
  key: string,
  patch: Partial<Omit<DownloadProgressState, "key" | "updatedAt">> & { status: DownloadPhase },
): void {
  const prev = progressMap.get(key);
  const bytesDownloaded = patch.bytesDownloaded ?? prev?.bytesDownloaded ?? 0;
  const totalBytes = patch.totalBytes !== undefined ? patch.totalBytes : (prev?.totalBytes ?? null);
  const percent =
    patch.percent !== undefined
      ? patch.percent
      : totalBytes && totalBytes > 0
        ? Math.min(100, Math.round((bytesDownloaded / totalBytes) * 100))
        : null;
  progressMap.set(key, {
    key,
    status: patch.status,
    bytesDownloaded,
    totalBytes,
    percent,
    assetName: patch.assetName ?? prev?.assetName,
    message: patch.message,
    updatedAt: Date.now(),
  });
}

export function getDownloadProgress(key: string): DownloadProgressState | null {
  const entry = progressMap.get(key);
  if (!entry) return null;
  if (
    (entry.status === "done" || entry.status === "error") &&
    Date.now() - entry.updatedAt > 30_000
  ) {
    progressMap.delete(key);
    return null;
  }
  return entry;
}

export function isSafeBinaryPathInput(rawPath: string): boolean {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.length > 1024) return false;
  return !UNSAFE_BIN_CHARS.test(trimmed);
}

export async function spawnTextAsync(
  command: string,
  args: string[],
  timeoutMs = 4_000,
): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  error?: string;
}> {
  return await new Promise((resolve) => {
    let settled = false;
    let totalBytes = 0;
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const MAX_CAPTURE = 512 * 1024;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        ok: false,
        stdout: "",
        stderr: "",
        code: null,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve({
        ok: false,
        stdout: Buffer.concat(outChunks).toString("utf8").trim(),
        stderr: Buffer.concat(errChunks).toString("utf8").trim(),
        code: null,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (totalBytes < MAX_CAPTURE) {
        totalBytes += chunk.length;
        outChunks.push(chunk);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (totalBytes < MAX_CAPTURE) {
        totalBytes += chunk.length;
        errChunks.push(chunk);
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout: "",
        stderr: "",
        code: null,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(outChunks).toString("utf8").trim(),
        stderr: Buffer.concat(errChunks).toString("utf8").trim(),
        code,
      });
    });
  });
}

export async function streamDownloadToFile(
  url: string,
  destPath: string,
  headers: Record<string, string>,
  maxBytes = 256 * 1024 * 1024,
  onProgress?: (bytesDownloaded: number, totalBytes: number | null) => void,
): Promise<{ ok: true; status: number; sha256: string; bytes: number } | { ok: false; status: number }> {
  const res = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok || !res.body) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return { ok: false, status: res.status };
  }

  const rawLen = Number(res.headers.get("content-length") ?? 0);
  const totalBytes = Number.isFinite(rawLen) && rawLen > 0 ? rawLen : null;
  const hash = createHash("sha256");
  const ws = createWriteStream(destPath, { mode: 0o600 });
  const reader = res.body.getReader();
  let total = 0;
  let lastProgressAt = 0;
  onProgress?.(0, totalBytes);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Download exceeded maximum allowed size (${maxBytes} bytes).`);
      }
      hash.update(value);
      if (!ws.write(value)) {
        await once(ws, "drain");
      }
      if (onProgress) {
        const now = Date.now();
        if (now - lastProgressAt >= 80) {
          lastProgressAt = now;
          onProgress(total, totalBytes);
        }
      }
    }
    ws.end();
    await once(ws, "close");
    onProgress?.(total, totalBytes);
    return {
      ok: true,
      status: res.status,
      sha256: hash.digest("hex"),
      bytes: total,
    };
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    try {
      ws.destroy();
    } catch {
      /* ignore */
    }
    try {
      rmSync(destPath, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function isSafeArchiveMember(entryLine: string): boolean {
  const trimmed = entryLine.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) return false;
  if (/^[a-zA-Z]:/.test(trimmed)) return false;
  const segments = trimmed.split(/[\\/]+/);
  return !segments.includes("..");
}

async function validateArchiveEntries(archivePath: string): Promise<void> {
  const isZip = archivePath.endsWith(".zip");
  const listArgs = isZip ? ["-tvf", archivePath] : ["-tzvf", archivePath];
  const listed = await spawnTextAsync("tar", listArgs, 15_000);
  if (!listed.ok) return;

  for (const rawLine of listed.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("l") || line.startsWith("h")) {
      throw new Error(`Refusing archive containing link entry: ${line}`);
    }
    const arrowIdx = line.indexOf(" -> ");
    const clean = arrowIdx !== -1 ? line.slice(0, arrowIdx) : line;
    const parts = clean.split(/\s+/);
    const memberPath = parts.length >= 9 ? parts.slice(8).join(" ") : clean;
    if (!isSafeArchiveMember(memberPath)) {
      throw new Error(`Refusing archive with unsafe path: ${memberPath}`);
    }
  }
}

async function runArchiveExtractDirect(input: {
  archivePath: string;
  destDir: string;
}): Promise<{ ok: true }> {
  const isZip = input.archivePath.endsWith(".zip");
  const tarArgs = isZip
    ? ["-xf", input.archivePath, "-C", input.destDir]
    : ["-xzf", input.archivePath, "-C", input.destDir];
  const res = await spawnTextAsync("tar", tarArgs, 30_000);
  if (res.ok) return { ok: true };

  if (process.platform === "win32" && isZip) {
    const ps = await spawnTextAsync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${input.archivePath.replace(/'/g, "''")}' -DestinationPath '${input.destDir.replace(/'/g, "''")}' -Force`,
      ],
      30_000,
    );
    if (ps.ok) return { ok: true };
    throw new Error(`Failed to extract archive: ${ps.stderr || "Expand-Archive failed"}`);
  }

  throw new Error(`Failed to extract archive: ${res.stderr || `tar exited ${res.code}`}`);
}

const EPHEMERAL_EXTRACT_SCRIPT = `
const { spawnSync } = require("node:child_process");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { buf += d; });
process.stdin.on("end", () => {
  const input = JSON.parse(buf);
  const isZip = input.archivePath.endsWith(".zip");
  const tarArgs = isZip
    ? ["-xf", input.archivePath, "-C", input.destDir]
    : ["-xzf", input.archivePath, "-C", input.destDir];
  const res = spawnSync("tar", tarArgs, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 30000, windowsHide: true });
  if (res.status === 0) {
    process.stdout.write(JSON.stringify({ ok: true }));
    return;
  }
  if (process.platform === "win32" && isZip) {
    const cmd = "Expand-Archive -LiteralPath '" + input.archivePath.replace(/'/g, "''") + "' -DestinationPath '" + input.destDir.replace(/'/g, "''") + "' -Force";
    const ps = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 30000, windowsHide: true });
    if (ps.status === 0) {
      process.stdout.write(JSON.stringify({ ok: true }));
      return;
    }
    process.stderr.write((ps.stderr || "Expand-Archive failed").trim());
    process.exit(1);
  }
  process.stderr.write((res.stderr || ("tar exited " + res.status)).trim());
  process.exit(1);
});
`;

export async function extractArchiveIsolated(
  archivePath: string,
  destDir: string,
): Promise<void> {
  await validateArchiveEntries(archivePath);
  const resolvedDest = path.resolve(destDir);
  await runEphemeralJob(
    EPHEMERAL_EXTRACT_SCRIPT,
    { archivePath: path.resolve(archivePath), destDir: resolvedDest },
    {
      timeoutMs: 35_000,
      fallback: runArchiveExtractDirect,
    },
  );
}
