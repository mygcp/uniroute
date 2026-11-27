import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pkg from "../../package.json";
import { setDownloadProgress, type DownloadPhase } from "./tool-exec-utils";

export const SELF_UPDATE_PROGRESS_KEY = "app:self-update";
export const BUNDLE_ASSET_NAME = "uni-bundle.tar.gz";

export type InstallMode = "bundle" | "binary" | "source";

export type InstallInfo = {
  currentVersion: string;
  repo: string;
  installMode: InstallMode;
  runtime: "bun" | "node";
  runtimeVersion: string;
  appDir: string;
  execPath: string;
  platform: NodeJS.Platform;
  arch: string;
  canSelfUpdate: boolean;
  canRestart: boolean;
  reason?: string;
};

export type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
  size?: number;
};

export type GitHubReleaseRaw = {
  tag_name: string;
  name?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
  created_at?: string | null;
  html_url?: string;
  body?: string | null;
  assets?: GitHubReleaseAsset[];
};

export type ReleaseSummary = {
  tag: string;
  version: string;
  name: string;
  publishedAt: string;
  prerelease: boolean;
  htmlUrl: string;
  body: string;
  isLatest: boolean;
  isCurrent: boolean;
  hasBundleAsset: boolean;
  hasBinaryAsset: boolean;
  bundleAssetName?: string;
  binaryAssetName?: string;
  bundleSizeBytes?: number;
  binarySizeBytes?: number;
};

export type ReleaseCatalog = {
  repo: string;
  currentVersion: string;
  latestTag: string | null;
  releases: ReleaseSummary[];
  fetchedAt: number;
};

export type UpdateProgressEvent = {
  status: DownloadPhase;
  bytesDownloaded: number;
  totalBytes: number | null;
  percent: number | null;
  assetName?: string;
};

export type ApplyUpdateResult = {
  ok: true;
  alreadyUpToDate?: boolean;
  mode: "bundle" | "binary";
  fromVersion: string;
  toVersion: string;
  tag: string;
  assetName: string;
  targetPath: string;
  restartRequired: boolean;
};

const RELEASES_CACHE_TTL_MS = 5 * 60_000;
const releasesCache = new Map<string, ReleaseCatalog>();

export function getDefaultRepo(): string {
  return process.env.UNIROUTE_REPO?.trim() || process.env.REPO?.trim() || "mygcp/uniroute";
}

export function normalizeTagVersion(tag: string): string {
  return tag.trim().replace(/^v/i, "");
}

export function isValidReleaseTarget(target: string): boolean {
  const t = target.trim();
  if (!t) return false;
  if (t.toLowerCase() === "latest") return true;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(t) && !t.includes("..");
}

export function getBinaryTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { target: string; artifact: string; ext: string } | null {
  if (platform === "linux" && arch === "x64") return { target: "bun-linux-x64", artifact: "uni-linux-x64", ext: "" };
  if (platform === "linux" && arch === "arm64") return { target: "bun-linux-arm64", artifact: "uni-linux-arm64", ext: "" };
  if (platform === "darwin" && arch === "x64") return { target: "bun-darwin-x64", artifact: "uni-darwin-x64", ext: "" };
  if (platform === "darwin" && arch === "arm64") return { target: "bun-darwin-arm64", artifact: "uni-darwin-arm64", ext: "" };
  if (platform === "win32") return { target: "bun-windows-x64", artifact: "uni-windows-x64.exe", ext: ".exe" };
  return null;
}

export function findBinaryAsset(
  assets: GitHubReleaseAsset[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): GitHubReleaseAsset | null {
  const tgt = getBinaryTarget(platform, arch);
  if (!tgt) return null;
  const preferred = [
    `${tgt.artifact}.tar.gz`,
    `${tgt.artifact}.zip`,
    tgt.artifact,
  ];
  for (const name of preferred) {
    const hit = assets.find((a) => a.name === name);
    if (hit) return hit;
  }
  return null;
}

export function detectCompiledBinary(): boolean {
  const dir = typeof import.meta.dir === "string" ? import.meta.dir : "";
  if (dir.startsWith("/$bunfs") || /^[A-Za-z]:[\\/]+~BUN/i.test(dir)) return true;
  const bin = path.basename(process.execPath).replace(/\.exe$/i, "").toLowerCase();
  return bin !== "bun" && bin !== "node";
}

function resolveModuleDir(): string {
  if (typeof import.meta.dir === "string") return import.meta.dir;
  return path.dirname(fileURLToPath(import.meta.url));
}

export function detectBundleDir(): string | null {
  const envDir = process.env.UNIROUTE_APP_DIR?.trim();
  if (envDir && fs.existsSync(envDir)) {
    return path.resolve(envDir);
  }
  if (process.env.UNIROUTE_INSTALL_MODE === "bundle") {
    const modDir = resolveModuleDir();
    if (fs.existsSync(path.join(modDir, "client"))) return modDir;
    return process.cwd();
  }
  const modDir = resolveModuleDir();
  if (
    fs.existsSync(path.join(modDir, "uni.mjs")) &&
    fs.existsSync(path.join(modDir, "client"))
  ) {
    return modDir;
  }
  return null;
}

export function getInstallInfo(): InstallInfo {
  const currentVersion = pkg.version || "1.1.0";
  const repo = getDefaultRepo();
  const runtime = typeof Bun !== "undefined" ? "bun" : "node";
  const runtimeVersion =
    typeof Bun !== "undefined" ? Bun.version : (process.versions.node ?? "unknown");

  let installMode: InstallMode = "source";
  let appDir = process.cwd();
  if (detectCompiledBinary()) {
    installMode = "binary";
    appDir = path.dirname(process.execPath);
  } else {
    const bundleDir = detectBundleDir();
    if (bundleDir) {
      installMode = "bundle";
      appDir = bundleDir;
    }
  }

  const canSelfUpdate = installMode === "bundle" || installMode === "binary";
  return {
    currentVersion,
    repo,
    installMode,
    runtime,
    runtimeVersion,
    appDir,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    canSelfUpdate,
    canRestart: canSelfUpdate,
    reason: canSelfUpdate
      ? undefined
      : "Running from a local source checkout. Use git to switch versions.",
  };
}

export function parseGitHubReleases(
  rawList: GitHubReleaseRaw[],
  currentVersion: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ReleaseSummary[] {
  const cleanCurrent = normalizeTagVersion(currentVersion);
  const nonDrafts = rawList.filter((r) => !r.draft && Boolean(r.tag_name));
  const latestNonPre = nonDrafts.find((r) => !r.prerelease) ?? nonDrafts[0];
  const latestTag = latestNonPre?.tag_name ?? null;

  return nonDrafts.map((r) => {
    const assets = Array.isArray(r.assets) ? r.assets : [];
    const bundleAsset = assets.find((a) => a.name === BUNDLE_ASSET_NAME) ?? null;
    const binaryAsset = findBinaryAsset(assets, platform, arch);
    const version = normalizeTagVersion(r.tag_name);
    return {
      tag: r.tag_name,
      version,
      name: (r.name || r.tag_name).trim(),
      publishedAt: r.published_at || r.created_at || "",
      prerelease: Boolean(r.prerelease),
      htmlUrl: r.html_url || "",
      body: (r.body || "").trim(),
      isLatest: r.tag_name === latestTag,
      isCurrent: version === cleanCurrent,
      hasBundleAsset: Boolean(bundleAsset),
      hasBinaryAsset: Boolean(binaryAsset),
      bundleAssetName: bundleAsset?.name,
      binaryAssetName: binaryAsset?.name,
      bundleSizeBytes: bundleAsset?.size,
      binarySizeBytes: binaryAsset?.size,
    };
  });
}

async function fetchGitHubJson<T>(url: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "uniroute-updater",
  };
  const ghToken = process.env.GITHUB_TOKEN?.trim();
  if (ghToken) {
    headers.Authorization = `Bearer ${ghToken}`;
  }
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const snippet = await res.text().then((t) => t.slice(0, 200)).catch(() => "");
    throw new Error(`GitHub API HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`);
  }
  return (await res.json()) as T;
}

export async function listGitHubReleases(opts?: {
  forceRefresh?: boolean;
  repo?: string;
}): Promise<ReleaseCatalog> {
  const repo = opts?.repo?.trim() || getDefaultRepo();
  const currentVersion = pkg.version || "1.1.0";
  const cached = releasesCache.get(repo);
  if (
    !opts?.forceRefresh &&
    cached &&
    Date.now() - cached.fetchedAt < RELEASES_CACHE_TTL_MS
  ) {
    return cached;
  }

  const raw = await fetchGitHubJson<GitHubReleaseRaw[]>(
    `https://api.github.com/repos/${repo}/releases?per_page=30`,
  );
  const releases = parseGitHubReleases(raw, currentVersion);
  const latestTag = releases.find((r) => r.isLatest)?.tag ?? releases[0]?.tag ?? null;
  const catalog: ReleaseCatalog = {
    repo,
    currentVersion,
    latestTag,
    releases,
    fetchedAt: Date.now(),
  };
  releasesCache.set(repo, catalog);
  return catalog;
}

export async function resolveTargetRelease(
  target: string,
  repo?: string,
): Promise<GitHubReleaseRaw> {
  const effectiveRepo = repo?.trim() || getDefaultRepo();
  const cleanTarget = target.trim() || "latest";
  if (!isValidReleaseTarget(cleanTarget)) {
    throw new Error(`Invalid release tag: ${target}`);
  }

  if (cleanTarget.toLowerCase() === "latest") {
    try {
      return await fetchGitHubJson<GitHubReleaseRaw>(
        `https://api.github.com/repos/${effectiveRepo}/releases/latest`,
      );
    } catch {
      const list = await fetchGitHubJson<GitHubReleaseRaw[]>(
        `https://api.github.com/repos/${effectiveRepo}/releases?per_page=20`,
      );
      const fallback = list.find((r) => !r.draft && !r.prerelease) ?? list.find((r) => !r.draft);
      if (!fallback) throw new Error("No published releases found on GitHub.");
      return fallback;
    }
  }

  const candidates = cleanTarget.startsWith("v")
    ? [cleanTarget, cleanTarget.slice(1)]
    : [`v${cleanTarget}`, cleanTarget];

  let lastErr: unknown = null;
  for (const tag of candidates) {
    try {
      return await fetchGitHubJson<GitHubReleaseRaw>(
        `https://api.github.com/repos/${effectiveRepo}/releases/tags/${encodeURIComponent(tag)}`,
      );
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Release "${cleanTarget}" not found in ${effectiveRepo}: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

async function downloadFileWithProgress(
  url: string,
  destPath: string,
  assetName: string,
  onProgress?: (ev: UpdateProgressEvent) => void,
): Promise<void> {
  const emit = (ev: UpdateProgressEvent) => {
    setDownloadProgress(SELF_UPDATE_PROGRESS_KEY, {
      status: ev.status,
      bytesDownloaded: ev.bytesDownloaded,
      totalBytes: ev.totalBytes,
      percent: ev.percent,
      assetName: ev.assetName,
    });
    onProgress?.(ev);
  };

  emit({
    status: "downloading",
    bytesDownloaded: 0,
    totalBytes: null,
    percent: null,
    assetName,
  });

  const res = await fetch(url, {
    headers: { "User-Agent": "uniroute-updater" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`Download failed with HTTP ${res.status}`);
  }

  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    emit({
      status: "downloading",
      bytesDownloaded: buf.byteLength,
      totalBytes: buf.byteLength,
      percent: 100,
      assetName,
    });
    return;
  }

  const total = Number(res.headers.get("content-length") ?? 0) || null;
  const ws = fs.createWriteStream(destPath);
  const reader = res.body.getReader();
  let received = 0;
  let lastEmit = 0;

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
      if (now - lastEmit >= 100) {
        lastEmit = now;
        emit({
          status: "downloading",
          bytesDownloaded: received,
          totalBytes: total,
          percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
          assetName,
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      ws.on("error", reject);
      ws.end(() => resolve());
    });
    emit({
      status: "downloading",
      bytesDownloaded: received,
      totalBytes: total ?? received,
      percent: 100,
      assetName,
    });
  } catch (err) {
    try {
      ws.destroy();
    } catch {
      // ignore
    }
    throw err;
  }
}

export function extractTarGz(archivePath: string, outDir: string): void {
  fs.mkdirSync(outDir, { recursive: true });
  const proc = spawnSync("tar", ["-xzf", archivePath, "-C", outDir], {
    encoding: "utf8",
  });
  if (proc.status !== 0) {
    throw new Error(proc.stderr?.trim() || proc.error?.message || "tar extraction failed");
  }
}

function extractZip(archivePath: string, outDir: string): void {
  fs.mkdirSync(outDir, { recursive: true });
  if (process.platform === "win32") {
    const proc = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force`,
      ],
      { encoding: "utf8" },
    );
    if (proc.status !== 0) {
      throw new Error(proc.stderr?.trim() || proc.error?.message || "zip extraction failed");
    }
    return;
  }
  const proc = spawnSync("unzip", ["-o", archivePath, "-d", outDir], {
    encoding: "utf8",
  });
  if (proc.status !== 0) {
    throw new Error(proc.stderr?.trim() || proc.error?.message || "unzip failed");
  }
}

export function resolveExtractedBundleRoot(extractDir: string): string {
  const hasMarkers = (dir: string) =>
    fs.existsSync(path.join(dir, "uni.mjs")) && fs.existsSync(path.join(dir, "client"));
  if (hasMarkers(extractDir)) return extractDir;
  const nested = path.join(extractDir, "bundle");
  if (hasMarkers(nested)) return nested;
  throw new Error("Downloaded bundle archive is missing uni.mjs or client assets.");
}

export function swapBundleDirectory(extractedRoot: string, appDir: string): void {
  const resolvedTarget = path.resolve(appDir);
  const parent = path.dirname(resolvedTarget);
  fs.mkdirSync(parent, { recursive: true });
  const backupDir = `${resolvedTarget}.bak`;
  fs.rmSync(backupDir, { recursive: true, force: true });

  const hadExisting = fs.existsSync(resolvedTarget);
  if (hadExisting) {
    fs.renameSync(resolvedTarget, backupDir);
  }
  try {
    try {
      fs.renameSync(extractedRoot, resolvedTarget);
    } catch {
      fs.cpSync(extractedRoot, resolvedTarget, { recursive: true });
    }
  } catch (err) {
    if (hadExisting && !fs.existsSync(resolvedTarget) && fs.existsSync(backupDir)) {
      try {
        fs.renameSync(backupDir, resolvedTarget);
      } catch {
        // leave backup intact for manual recovery
      }
    }
    throw err;
  }
}

function replaceExecutable(newBinaryPath: string, targetPath: string): void {
  const backupPath = `${targetPath}.bak`;
  try {
    if (fs.existsSync(targetPath)) {
      fs.copyFileSync(targetPath, backupPath);
    }
  } catch {
    // ignore backup copy errors
  }

  if (process.platform === "win32" && fs.existsSync(targetPath)) {
    const oldPath = `${targetPath}.old`;
    try {
      fs.rmSync(oldPath, { force: true });
    } catch {
      // ignore
    }
    fs.renameSync(targetPath, oldPath);
    try {
      fs.copyFileSync(newBinaryPath, targetPath);
    } catch (err) {
      try {
        if (!fs.existsSync(targetPath) && fs.existsSync(oldPath)) {
          fs.renameSync(oldPath, targetPath);
        }
      } catch {
        // ignore rollback failure
      }
      throw err;
    }
    return;
  }

  fs.copyFileSync(newBinaryPath, targetPath);
  fs.chmodSync(targetPath, 0o755);
}

export async function applyAppUpdate(opts: {
  target?: string;
  force?: boolean;
  repo?: string;
  onProgress?: (ev: UpdateProgressEvent) => void;
}): Promise<ApplyUpdateResult> {
  const info = getInstallInfo();
  if (!info.canSelfUpdate) {
    throw new Error(info.reason || "Self-update is not available in source mode.");
  }

  const repo = opts.repo?.trim() || info.repo;
  const target = (opts.target ?? "latest").trim() || "latest";

  setDownloadProgress(SELF_UPDATE_PROGRESS_KEY, {
    status: "resolving",
    bytesDownloaded: 0,
    totalBytes: null,
    percent: null,
  });
  opts.onProgress?.({
    status: "resolving",
    bytesDownloaded: 0,
    totalBytes: null,
    percent: null,
  });

  const release = await resolveTargetRelease(target, repo);
  const tag = release.tag_name;
  const toVersion = normalizeTagVersion(tag);
  const fromVersion = info.currentVersion;

  if (toVersion === normalizeTagVersion(fromVersion) && !opts.force) {
    setDownloadProgress(SELF_UPDATE_PROGRESS_KEY, {
      status: "done",
      bytesDownloaded: 0,
      totalBytes: null,
      percent: 100,
    });
    return {
      ok: true,
      alreadyUpToDate: true,
      mode: info.installMode === "bundle" ? "bundle" : "binary",
      fromVersion,
      toVersion,
      tag,
      assetName: "",
      targetPath: info.installMode === "bundle" ? info.appDir : info.execPath,
      restartRequired: false,
    };
  }

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uniroute-update-"));

  try {
    if (info.installMode === "bundle") {
      const bundleAsset = assets.find((a) => a.name === BUNDLE_ASSET_NAME);
      if (!bundleAsset) {
        throw new Error(
          `Release ${tag} does not include ${BUNDLE_ASSET_NAME}.`,
        );
      }
      const archivePath = path.join(tmpRoot, bundleAsset.name);
      await downloadFileWithProgress(
        bundleAsset.browser_download_url,
        archivePath,
        bundleAsset.name,
        opts.onProgress,
      );

      setDownloadProgress(SELF_UPDATE_PROGRESS_KEY, {
        status: "extracting",
        bytesDownloaded: bundleAsset.size ?? 0,
        totalBytes: bundleAsset.size ?? null,
        percent: 100,
        assetName: bundleAsset.name,
      });
      opts.onProgress?.({
        status: "extracting",
        bytesDownloaded: bundleAsset.size ?? 0,
        totalBytes: bundleAsset.size ?? null,
        percent: 100,
        assetName: bundleAsset.name,
      });

      const extractDir = path.join(tmpRoot, "extract");
      extractTarGz(archivePath, extractDir);
      const bundleRoot = resolveExtractedBundleRoot(extractDir);
      swapBundleDirectory(bundleRoot, info.appDir);

      setDownloadProgress(SELF_UPDATE_PROGRESS_KEY, {
        status: "done",
        bytesDownloaded: bundleAsset.size ?? 0,
        totalBytes: bundleAsset.size ?? null,
        percent: 100,
        assetName: bundleAsset.name,
      });

      return {
        ok: true,
        mode: "bundle",
        fromVersion,
        toVersion,
        tag,
        assetName: bundleAsset.name,
        targetPath: info.appDir,
        restartRequired: true,
      };
    }

    const binaryAsset = findBinaryAsset(assets, info.platform, info.arch);
    const tgt = getBinaryTarget(info.platform, info.arch);
    if (!binaryAsset || !tgt) {
      throw new Error(
        `No compatible binary asset found in ${tag} for ${info.platform}/${info.arch}.`,
      );
    }

    const downloadPath = path.join(tmpRoot, binaryAsset.name);
    await downloadFileWithProgress(
      binaryAsset.browser_download_url,
      downloadPath,
      binaryAsset.name,
      opts.onProgress,
    );

    let newBinary = downloadPath;
    if (binaryAsset.name.endsWith(".tar.gz") || binaryAsset.name.endsWith(".zip")) {
      setDownloadProgress(SELF_UPDATE_PROGRESS_KEY, {
        status: "extracting",
        bytesDownloaded: binaryAsset.size ?? 0,
        totalBytes: binaryAsset.size ?? null,
        percent: 100,
        assetName: binaryAsset.name,
      });
      const outDir = path.join(tmpRoot, "extract");
      if (binaryAsset.name.endsWith(".tar.gz")) {
        extractTarGz(downloadPath, outDir);
      } else {
        extractZip(downloadPath, outDir);
      }
      const found = fs.readdirSync(outDir, { recursive: true } as any) as unknown as string[];
      const match =
        found.find((p) => String(p).endsWith(tgt.artifact)) ??
        found.find((p) => String(p).includes("uni-"));
      if (!match) {
        throw new Error(`Binary ${tgt.artifact} not found inside ${binaryAsset.name}.`);
      }
      newBinary = path.join(outDir, String(match));
    }

    replaceExecutable(newBinary, info.execPath);

    setDownloadProgress(SELF_UPDATE_PROGRESS_KEY, {
      status: "done",
      bytesDownloaded: binaryAsset.size ?? 0,
      totalBytes: binaryAsset.size ?? null,
      percent: 100,
      assetName: binaryAsset.name,
    });

    return {
      ok: true,
      mode: "binary",
      fromVersion,
      toVersion,
      tag,
      assetName: binaryAsset.name,
      targetPath: info.execPath,
      restartRequired: true,
    };
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup failure
    }
  }
}

export function scheduleAppRestart(): { scheduled: boolean; message: string } {
  const info = getInstallInfo();
  if (!info.canRestart) {
    return {
      scheduled: false,
      message: "Restart manually from your terminal in source checkout mode.",
    };
  }

  const timer = setTimeout(() => {
    const args =
      info.installMode === "bundle"
        ? [path.join(info.appDir, "uni.mjs"), "restart", "--daemon"]
        : ["restart", "--daemon"];
    try {
      const child = spawn(info.execPath, args, {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
    } catch {
      // ignore spawn error on exit
    }
    process.exit(0);
  }, 350);
  timer.unref?.();

  return {
    scheduled: true,
    message: "Restarting UniRoute in the background...",
  };
}
