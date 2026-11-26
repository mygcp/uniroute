import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { singleflight, TtlCache } from "./async-utils";
import {
  extractArchiveIsolated,
  isSafeBinaryPathInput,
  setDownloadProgress,
  spawnTextAsync,
  streamDownloadToFile,
} from "./tool-exec-utils";

export type CompressorToolId = "rtk" | "caveman";

export type ToolKind =
  | "rtk-cli"
  | "caveman-engine"
  | "custom"
  | "stub"
  | "missing";

export type ToolSource = "managed" | "path" | "custom" | "stub" | "missing";

export type ToolInstallCommand = {
  label: string;
  command: string;
};

export type ToolStatus = {
  id: CompressorToolId;
  name: string;
  tagline: string;
  repoUrl: string;
  releasesUrl: string;
  license: string;
  installed: boolean;
  isManaged: boolean;
  isStub: boolean;
  source: ToolSource;
  resolvedPath: string | null;
  configuredPath: string;
  managedPath: string;
  version: string | null;
  sizeBytes: number | null;
  kind: ToolKind;
  installCommands: ToolInstallCommand[];
};

export type DownloadToolResult = {
  tool: CompressorToolId;
  tag: string;
  assetName: string;
  binaryPath: string;
  version: string | null;
  sha256: string;
  checksumVerified: boolean;
  sizeBytes: number;
  upToDate?: boolean;
};

export {
  CAVEMAN_TYPES,
  RTK_FILTERS,
  VALID_CAVEMAN_TYPES,
  VALID_RTK_FILTERS,
} from "../lib/compression-options";

type ToolMeta = {
  id: CompressorToolId;
  name: string;
  tagline: string;
  repoUrl: string;
  releasesUrl: string;
  license: string;
  managedWinName: string;
  managedPosixName: string;
  pathNames: string[];
  installCommands: ToolInstallCommand[];
};

const TOOL_META: Record<CompressorToolId, ToolMeta> = {
  rtk: {
    id: "rtk",
    name: "RTK (Rust Token Killer)",
    tagline:
      "Rust CLI filter that compresses noisy test runs, git diffs, grep hits, and logs via `rtk pipe`.",
    repoUrl: "https://github.com/rtk-ai/rtk",
    releasesUrl: "https://github.com/rtk-ai/rtk/releases",
    license: "Apache-2.0",
    managedWinName: "rtk.exe",
    managedPosixName: "rtk",
    pathNames: ["rtk"],
    installCommands: [
      { label: "Windows (winget)", command: "winget install rtk-ai.rtk" },
      { label: "macOS / Linux (Homebrew)", command: "brew install rtk" },
      {
        label: "Linux / macOS (shell)",
        command:
          "curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh",
      },
    ],
  },
  caveman: {
    id: "caveman",
    name: "Caveman Engine",
    tagline:
      "Go context compression engine (`caveman-engine compress`) with 16 content-aware compressors and local recovery.",
    repoUrl: "https://github.com/JuliusBrussee/caveman",
    releasesUrl: "https://github.com/JuliusBrussee/caveman/releases",
    license: "Apache-2.0",
    managedWinName: "caveman-engine.exe",
    managedPosixName: "caveman-engine",
    pathNames: ["caveman-engine"],
    installCommands: [
      {
        label: "Windows (PowerShell)",
        command:
          "irm https://raw.githubusercontent.com/JuliusBrussee/caveman/main/install.ps1 | iex",
      },
      {
        label: "macOS / Linux (shell)",
        command:
          "curl -fsSL https://raw.githubusercontent.com/JuliusBrussee/caveman/main/install.sh | bash",
      },
      { label: "Node / npm CLI", command: "npm install -g @caveman-ai/cli" },
    ],
  },
};

export function toolsDir(): string {
  return (
    process.env.UNIROUTE_TOOLS_DIR?.trim() ||
    path.join(homedir(), ".uniroute", "bin")
  );
}

export function managedBinaryPath(
  tool: CompressorToolId,
  platform: NodeJS.Platform = process.platform,
): string {
  const meta = TOOL_META[tool];
  return path.join(
    toolsDir(),
    platform === "win32" ? meta.managedWinName : meta.managedPosixName,
  );
}

export function isLegacyStubPath(rawPath: string | null | undefined): boolean {
  const norm = (rawPath ?? "").trim().replace(/\\/g, "/");
  return norm === "./bin/rtk" || norm === "./bin/caveman" || norm === "bin/rtk" || norm === "bin/caveman";
}

function isMockStubFile(filePath: string): boolean {
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size > 256) return false;
    const head = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n").trim();
    return head === "#!/bin/sh\ncat";
  } catch {
    return false;
  }
}

function findOnSystemPath(names: string[]): string | null {
  if (typeof Bun !== "undefined") {
    for (const name of names) {
      const found = Bun.which(name);
      if (found && existsSync(found)) return found;
    }
  }
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const isWin = process.platform === "win32";
  const exts = isWin
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
        .split(";")
        .filter(Boolean)
        .map((e) => e.toLowerCase())
    : [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidates = isWin
        ? [name, ...exts.map((ext) => `${name}${ext}`)]
        : [name];
      for (const c of candidates) {
        const full = path.join(dir, c);
        try {
          if (statSync(full).isFile()) return full;
        } catch {
          /* skip */
        }
      }
    }
  }
  return null;
}

function resolveConfiguredPath(rawPath: string): string | null {
  if (!isSafeBinaryPathInput(rawPath)) return null;
  const trimmed = rawPath.trim();
  const hasSep =
    trimmed.includes("/") || trimmed.includes("\\") || trimmed.startsWith(".");
  if (!hasSep) {
    return findOnSystemPath([trimmed]);
  }
  const abs = path.resolve(trimmed);
  if (existsSync(abs)) {
    try {
      if (statSync(abs).isFile()) return abs;
    } catch {
      /* skip */
    }
  }
  if (process.platform === "win32") {
    for (const ext of [".exe", ".cmd", ".bat"]) {
      const withExt = `${abs}${ext}`;
      if (existsSync(withExt)) {
        try {
          if (statSync(withExt).isFile()) return withExt;
        } catch {
          /* skip */
        }
      }
    }
  }
  return null;
}

type ProbeCacheEntry = {
  kind: ToolKind;
  version: string | null;
};

const probeCache = new TtlCache<string, ProbeCacheEntry>(64, 300_000);

export function clearProbeCache(): void {
  probeCache.clear();
}

async function runQuickProbe(
  binaryPath: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string }> {
  const res = await spawnTextAsync(binaryPath, args, 2_500);
  return { ok: res.ok, stdout: res.stdout };
}

export async function detectBinaryKind(
  tool: CompressorToolId,
  resolvedPath: string,
): Promise<ProbeCacheEntry> {
  if (isMockStubFile(resolvedPath)) {
    return { kind: "stub", version: null };
  }

  let cacheKey = `${tool}:${resolvedPath}`;
  try {
    const st = statSync(resolvedPath);
    cacheKey = `${tool}:${resolvedPath}:${st.mtimeMs}:${st.size}`;
  } catch {
    /* ignore */
  }
  const cached = probeCache.get(cacheKey);
  if (cached) return cached;

  return await singleflight(`probe:compressor:${cacheKey}`, async () => {
    const recheck = probeCache.get(cacheKey);
    if (recheck) return recheck;

    let entry: ProbeCacheEntry = { kind: "custom", version: null };

    if (tool === "rtk") {
      const res = await runQuickProbe(resolvedPath, ["--version"]);
      const m = res.stdout.match(/^rtk\s+v?([0-9]+\.[0-9]+\.[0-9]+[^\s]*)/i);
      if (res.ok && m) {
        entry = { kind: "rtk-cli", version: m[1]! };
      }
    } else {
      const jsonRes = await runQuickProbe(resolvedPath, ["version", "--json"]);
      if (jsonRes.ok && jsonRes.stdout.startsWith("{")) {
        try {
          const parsed = JSON.parse(jsonRes.stdout) as {
            version?: string;
            schema?: string;
            capabilities?: string[];
          };
          if (
            parsed.schema?.startsWith("caveman.engine") ||
            parsed.capabilities?.includes("compress")
          ) {
            entry = {
              kind: "caveman-engine",
              version: parsed.version
                ? String(parsed.version).replace(/^(bin-)?v/i, "")
                : null,
            };
          }
        } catch {
          /* ignore malformed json */
        }
      }
    }

    probeCache.set(cacheKey, entry);
    return entry;
  });
}

export function resolveToolBinary(
  tool: CompressorToolId,
  configuredPath: string | null | undefined,
): {
  resolvedPath: string | null;
  source: ToolSource;
} {
  const cfg = (configuredPath ?? "").trim();
  const managed = managedBinaryPath(tool);

  // 1. Explicit non-stub custom path saved by the user
  if (cfg && !isLegacyStubPath(cfg)) {
    const resolved = resolveConfiguredPath(cfg);
    if (resolved) {
      const isSameManaged =
        path.resolve(resolved).toLowerCase() ===
        path.resolve(managed).toLowerCase();
      return {
        resolvedPath: resolved,
        source: isSameManaged ? "managed" : "custom",
      };
    }
    return { resolvedPath: null, source: "missing" };
  }

  // 2. Managed external binary downloaded to ~/.uniroute/bin/
  if (existsSync(managed)) {
    try {
      if (statSync(managed).isFile()) {
        return { resolvedPath: managed, source: "managed" };
      }
    } catch {
      /* skip */
    }
  }

  // 3. System PATH installation (winget / brew / manual)
  const onPath = findOnSystemPath(TOOL_META[tool].pathNames);
  if (onPath) {
    return { resolvedPath: onPath, source: "path" };
  }

  // 4. Legacy dummy stub (./bin/rtk or ./bin/caveman) if explicitly set in old DB
  if (cfg && isLegacyStubPath(cfg)) {
    const stub = resolveConfiguredPath(cfg);
    if (stub) {
      return {
        resolvedPath: stub,
        source: isMockStubFile(stub) ? "stub" : "custom",
      };
    }
  }

  return { resolvedPath: null, source: "missing" };
}

export async function probeTool(
  tool: CompressorToolId,
  configuredPath: string | null | undefined,
): Promise<ToolStatus> {
  const meta = TOOL_META[tool];
  const managed = managedBinaryPath(tool);
  const { resolvedPath, source } = resolveToolBinary(tool, configuredPath);

  let kind: ToolKind = "missing";
  let version: string | null = null;
  let sizeBytes: number | null = null;

  if (resolvedPath) {
    try {
      sizeBytes = statSync(resolvedPath).size;
    } catch {
      sizeBytes = null;
    }
    const probed = await detectBinaryKind(tool, resolvedPath);
    kind = probed.kind;
    version = probed.version;
  }

  const isStub = kind === "stub" || source === "stub";
  const installed = resolvedPath !== null && !isStub;

  return {
    id: tool,
    name: meta.name,
    tagline: meta.tagline,
    repoUrl: meta.repoUrl,
    releasesUrl: meta.releasesUrl,
    license: meta.license,
    installed,
    isManaged: source === "managed",
    isStub,
    source: isStub ? "stub" : source,
    resolvedPath,
    configuredPath: (configuredPath ?? "").trim(),
    managedPath: managed,
    version,
    sizeBytes,
    kind,
    installCommands: meta.installCommands,
  };
}

/* -------------------- Zero-Auth VPS-Friendly Release Download -------------- */

function webHeaders(): Record<string, string> {
  return {
    "User-Agent": "uniroute-compressor-downloader/1.0",
  };
}

export function selectRtkAssetCandidates(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string[] {
  if (platform === "win32") {
    if (arch === "x64") {
      return [
        "rtk-oss-x86_64-pc-windows-msvc.zip",
        "rtk-x86_64-pc-windows-msvc.zip",
      ];
    }
    return [];
  }
  if (platform === "darwin") {
    if (arch === "arm64") {
      return [
        "rtk-oss-aarch64-apple-darwin.tar.gz",
        "rtk-aarch64-apple-darwin.tar.gz",
      ];
    }
    if (arch === "x64") {
      return [
        "rtk-oss-x86_64-apple-darwin.tar.gz",
        "rtk-x86_64-apple-darwin.tar.gz",
      ];
    }
    return [];
  }
  if (platform === "linux") {
    if (arch === "x64") {
      return [
        "rtk-oss-x86_64-unknown-linux-musl.tar.gz",
        "rtk-x86_64-unknown-linux-musl.tar.gz",
      ];
    }
    if (arch === "arm64") {
      return [
        "rtk-oss-aarch64-unknown-linux-musl.tar.gz",
        "rtk-oss-aarch64-unknown-linux-gnu.tar.gz",
        "rtk-aarch64-unknown-linux-musl.tar.gz",
        "rtk-aarch64-unknown-linux-gnu.tar.gz",
      ];
    }
  }
  return [];
}

export function selectCavemanAssetCandidates(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string[] {
  const osPart =
    platform === "win32"
      ? "win32"
      : platform === "darwin"
        ? "darwin"
        : platform === "linux"
          ? "linux"
          : null;
  const archPart = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!osPart || !archPart) return [];
  return [`caveman-engine_${osPart}_${archPart}`];
}

export function parseChecksumForAsset(
  checksumsText: string,
  assetName: string,
): string | null {
  for (const rawLine of checksumsText.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (!m) continue;
    const hash = m[1]!.toLowerCase();
    const file = m[2]!.trim().replace(/^\.\//, "");
    if (file === assetName || path.basename(file) === assetName) {
      return hash;
    }
  }
  return null;
}

function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function findFileRecursive(dir: string, targetNames: string[]): string | null {
  const rootResolved = path.resolve(dir);
  const wanted = new Set(targetNames.map((n) => n.toLowerCase()));
  const entries = readdirSync(rootResolved, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.resolve(rootResolved, entry.name);
    if (!full.startsWith(rootResolved + path.sep)) continue;
    if (entry.isFile() && wanted.has(entry.name.toLowerCase())) {
      try {
        if (!lstatSync(full).isSymbolicLink()) return full;
      } catch {
        /* skip */
      }
    }
    if (entry.isDirectory()) {
      const nested = findFileRecursive(full, targetNames);
      if (nested) return nested;
    }
  }
  return null;
}

export function extractTagFromRedirect(location: string | null): string | null {
  if (!location) return null;
  const m = location.match(/\/releases\/tag\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

export function extractLatestTagFromAtom(
  atomXml: string,
  prefix?: string,
): string | null {
  const re = /\/releases\/tag\/([^"'<>\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(atomXml)) !== null) {
    const tag = decodeURIComponent(match[1]!);
    if (!prefix || tag.startsWith(prefix)) return tag;
  }
  return null;
}

/**
 * Resolve latest release tag TANPA api.github.com (nol auth, nol 60/jam IP limit di VPS).
 * Menggunakan HTTP redirect `/releases/latest` dan/atau RSS feed publik `/releases.atom`.
 */
async function resolveLatestTagNoApi(tool: CompressorToolId): Promise<string> {
  const headers = webHeaders();

  if (tool === "rtk") {
    const pinned = process.env.UNIROUTE_RTK_VERSION?.trim();
    if (pinned) return pinned;

    // 1) Fast HEAD redirect on github.com/releases/latest (no API quota)
    try {
      const head = await fetch(
        "https://github.com/rtk-ai/rtk/releases/latest",
        { method: "HEAD", redirect: "manual", headers },
      );
      const tag = extractTagFromRedirect(head.headers.get("location"));
      if (tag) return tag;
    } catch {
      /* fall through to atom */
    }

    // 2) Public Atom feed (no API quota)
    const atomRes = await fetch(
      "https://github.com/rtk-ai/rtk/releases.atom",
      { headers, redirect: "follow" },
    );
    if (atomRes.ok) {
      const tag = extractLatestTagFromAtom(await atomRes.text(), "v");
      if (tag) return tag;
    }
    return "latest";
  }

  const pinned = process.env.UNIROUTE_CAVEMAN_VERSION?.trim();
  if (pinned) return pinned;

  // 1) Public Atom feed lists all `bin-v*` binary releases without api.github.com
  try {
    const atomRes = await fetch(
      "https://github.com/JuliusBrussee/caveman/releases.atom",
      { headers, redirect: "follow" },
    );
    if (atomRes.ok) {
      const tag = extractLatestTagFromAtom(await atomRes.text(), "bin-v");
      if (tag) return tag;
    }
  } catch {
    /* fall through to redirect */
  }

  // 2) Fallback: HEAD /releases/latest -> map vX.Y.Z to bin-vX.Y.Z
  const head = await fetch(
    "https://github.com/JuliusBrussee/caveman/releases/latest",
    { method: "HEAD", redirect: "manual", headers },
  );
  const latestTag = extractTagFromRedirect(head.headers.get("location"));
  if (latestTag) {
    return latestTag.startsWith("bin-") ? latestTag : `bin-${latestTag}`;
  }

  throw new Error(
    "Could not determine the latest Caveman binary release tag from github.com.",
  );
}

function directReleaseDownloadUrl(
  tool: CompressorToolId,
  tag: string,
  assetName: string,
): string {
  const repo = tool === "rtk" ? "rtk-ai/rtk" : "JuliusBrussee/caveman";
  if (tag === "latest") {
    return `https://github.com/${repo}/releases/latest/download/${encodeURIComponent(assetName)}`;
  }
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

/**
 * Download binary resmi langsung dari github.com Releases ke `~/.uniroute/bin/`
 * (terpisah dari aplikasi, tanpa api.github.com / tanpa OAuth / aman untuk VPS).
 * Selalu verifikasi SHA-256 terhadap `checksums.txt` dari rilis yang sama.
 */
export async function downloadTool(
  tool: CompressorToolId,
  opts: { force?: boolean } = {},
): Promise<DownloadToolResult> {
  return await singleflight(`download:compressor:${tool}`, () =>
    downloadToolImpl(tool, opts),
  );
}

function normalizeVer(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/^(bin-)?v/i, "").toLowerCase();
}

async function downloadToolImpl(
  tool: CompressorToolId,
  opts: { force?: boolean } = {},
): Promise<DownloadToolResult> {
  const progressKey = `compressor:${tool}`;
  const candidates =
    tool === "rtk"
      ? selectRtkAssetCandidates()
      : selectCavemanAssetCandidates();

  if (candidates.length === 0) {
    throw new Error(
      `No prebuilt ${tool} binary available for ${process.platform}/${process.arch}. Install manually via PATH.`,
    );
  }

  const headers = webHeaders();
  const customUrl =
    tool === "rtk"
      ? process.env.UNIROUTE_RTK_DOWNLOAD_URL?.trim()
      : process.env.UNIROUTE_CAVEMAN_DOWNLOAD_URL?.trim();

  const destDir = toolsDir();
  mkdirSync(destDir, { recursive: true });
  const targetPath = managedBinaryPath(tool);

  let tag = "custom";
  let matchedAssetName = candidates[0]!;
  let actualSha = "";
  let downloadedFilePath = "";
  let checksumVerified = false;
  let lastStatus = 0;

  setDownloadProgress(progressKey, {
    status: "resolving",
    bytesDownloaded: 0,
    totalBytes: null,
    percent: null,
  });

  const tmpDir = mkdtempSync(path.join(destDir, `.dl-${tool}-`));

  try {
    if (customUrl) {
      matchedAssetName = path.basename(new URL(customUrl).pathname) || matchedAssetName;
      const destFile = path.join(tmpDir, path.basename(matchedAssetName));
      setDownloadProgress(progressKey, {
        status: "downloading",
        assetName: matchedAssetName,
        bytesDownloaded: 0,
        totalBytes: null,
        percent: 0,
      });
      const dl = await streamDownloadToFile(
        customUrl,
        destFile,
        headers,
        256 * 1024 * 1024,
        (bytesDownloaded, totalBytes) => {
          setDownloadProgress(progressKey, {
            status: "downloading",
            assetName: matchedAssetName,
            bytesDownloaded,
            totalBytes,
          });
        },
      );
      if (!dl.ok) {
        throw new Error(`Failed to download from custom URL (HTTP ${dl.status}).`);
      }
      actualSha = dl.sha256;
      downloadedFilePath = destFile;
    } else {
      tag = await resolveLatestTagNoApi(tool);
      if (!opts.force && existsSync(targetPath)) {
        const current = await probeTool(tool, targetPath);
        const curVer = normalizeVer(current.version);
        const targetVer = normalizeVer(tag);
        if (current.installed && curVer && targetVer && curVer === targetVer) {
          setDownloadProgress(progressKey, {
            status: "done",
            bytesDownloaded: current.sizeBytes ?? 0,
            totalBytes: current.sizeBytes ?? 0,
            percent: 100,
          });
          return {
            tool,
            tag,
            assetName: candidates[0]!,
            binaryPath: targetPath,
            version: current.version,
            sha256: "",
            checksumVerified: true,
            sizeBytes: current.sizeBytes ?? statSync(targetPath).size,
            upToDate: true,
          };
        }
      }

      for (const candidate of candidates) {
        const url = directReleaseDownloadUrl(tool, tag, candidate);
        const destFile = path.join(tmpDir, path.basename(candidate));
        setDownloadProgress(progressKey, {
          status: "downloading",
          assetName: candidate,
          bytesDownloaded: 0,
          totalBytes: null,
          percent: 0,
        });
        const dl = await streamDownloadToFile(
          url,
          destFile,
          headers,
          256 * 1024 * 1024,
          (bytesDownloaded, totalBytes) => {
            setDownloadProgress(progressKey, {
              status: "downloading",
              assetName: candidate,
              bytesDownloaded,
              totalBytes,
            });
          },
        );
        lastStatus = dl.status;
        if (dl.ok) {
          actualSha = dl.sha256;
          downloadedFilePath = destFile;
          matchedAssetName = candidate;
          break;
        }
      }
      if (!downloadedFilePath) {
        throw new Error(
          `Failed to download ${tool} (${tag}, tried ${candidates.join(", ")}, last HTTP ${lastStatus}).`,
        );
      }
    }

    if (!customUrl) {
      setDownloadProgress(progressKey, { status: "verifying" });
      const requireChecksum =
        tool === "rtk" && process.env.UNIROUTE_ALLOW_UNVERIFIED_DOWNLOAD !== "1";
      const csUrl = directReleaseDownloadUrl(tool, tag, "checksums.txt");
      const csRes = await fetch(csUrl, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
      if (csRes.ok) {
        const expected = parseChecksumForAsset(
          await csRes.text(),
          matchedAssetName,
        );
        if (!expected) {
          throw new Error(
            `Checksum entry missing for ${matchedAssetName} in ${tag}. Download aborted.`,
          );
        }
        if (expected !== actualSha) {
          throw new Error(
            `SHA-256 mismatch for ${matchedAssetName} (expected ${expected.slice(0, 12)}..., got ${actualSha.slice(0, 12)}...). Download aborted.`,
          );
        }
        checksumVerified = true;
      } else if (requireChecksum) {
        throw new Error(
          `Failed to download checksum manifest for ${tool} (${tag}, HTTP ${csRes.status}).`,
        );
      }
    }

    let sourceBinPath: string;
    if (
      matchedAssetName.endsWith(".zip") ||
      matchedAssetName.endsWith(".tar.gz")
    ) {
      setDownloadProgress(progressKey, { status: "extracting" });
      const extractDir = path.join(tmpDir, "extract");
      mkdirSync(extractDir, { recursive: true });
      await extractArchiveIsolated(downloadedFilePath, extractDir);
      const wanted =
        process.platform === "win32"
          ? [TOOL_META[tool].managedWinName, TOOL_META[tool].managedPosixName]
          : [TOOL_META[tool].managedPosixName];
      const found = findFileRecursive(extractDir, wanted);
      if (!found) {
        throw new Error(
          `Downloaded archive ${matchedAssetName} did not contain ${wanted.join(" or ")}.`,
        );
      }
      sourceBinPath = found;
    } else {
      sourceBinPath = downloadedFilePath;
    }

    const staging = `${targetPath}.tmp-${process.pid}`;
    copyFileSync(sourceBinPath, staging);
    if (process.platform !== "win32") {
      chmodSync(staging, 0o755);
    }
    renameSync(staging, targetPath);
  } catch (err) {
    setDownloadProgress(progressKey, {
      status: "error",
      message: err instanceof Error ? err.message : "Download failed.",
    });
    throw err;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  clearProbeCache();
  const probed = await probeTool(tool, targetPath);
  if (!probed.installed) {
    setDownloadProgress(progressKey, {
      status: "error",
      message: `Could not verify binary at ${targetPath}.`,
    });
    throw new Error(
      `Downloaded ${matchedAssetName}, but could not verify binary at ${targetPath}.`,
    );
  }

  const sizeBytes = statSync(targetPath).size;
  setDownloadProgress(progressKey, {
    status: "done",
    bytesDownloaded: sizeBytes,
    totalBytes: sizeBytes,
    percent: 100,
  });

  return {
    tool,
    tag,
    assetName: matchedAssetName,
    binaryPath: targetPath,
    version: probed.version ?? tag.replace(/^(bin-)?v/i, ""),
    sha256: actualSha,
    checksumVerified,
    sizeBytes,
  };
}

export function uninstallTool(tool: CompressorToolId): {
  removed: boolean;
  path: string;
} {
  const target = managedBinaryPath(tool);
  if (!existsSync(target)) {
    return { removed: false, path: target };
  }
  unlinkSync(target);
  clearProbeCache();
  return { removed: true, path: target };
}
