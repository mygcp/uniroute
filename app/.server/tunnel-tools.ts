import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  TUNNEL_PROVIDERS,
  type DownloadTunnelToolResult,
  type TunnelInstallCommand,
  type TunnelProviderId,
  type TunnelToolSource,
  type TunnelToolStatus,
} from "../lib/tunnel-options";

type TunnelBinaryMeta = {
  managedWinName: string;
  managedPosixName: string;
  pathNames: string[];
  versionArgs: string[];
  installCommands: TunnelInstallCommand[];
};

const BINARY_META: Record<TunnelProviderId, TunnelBinaryMeta> = {
  cloudflared: {
    managedWinName: "cloudflared.exe",
    managedPosixName: "cloudflared",
    pathNames: ["cloudflared"],
    versionArgs: ["--version"],
    installCommands: [
      { label: "Windows (winget)", command: "winget install Cloudflare.cloudflared" },
      { label: "macOS (Homebrew)", command: "brew install cloudflared" },
      {
        label: "Linux (direct binary)",
        command:
          "curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared && chmod +x ~/.local/bin/cloudflared",
      },
    ],
  },
  ngrok: {
    managedWinName: "ngrok.exe",
    managedPosixName: "ngrok",
    pathNames: ["ngrok"],
    versionArgs: ["version"],
    installCommands: [
      { label: "Windows (winget)", command: "winget install Ngrok.Ngrok" },
      { label: "macOS (Homebrew)", command: "brew install ngrok/ngrok/ngrok" },
      { label: "Linux (snap)", command: "snap install ngrok" },
    ],
  },
  frpc: {
    managedWinName: "frpc.exe",
    managedPosixName: "frpc",
    pathNames: ["frpc"],
    versionArgs: ["--version"],
    installCommands: [
      { label: "macOS / Linux (Homebrew)", command: "brew install frpc" },
      { label: "Scoop (Windows)", command: "scoop install frp" },
      {
        label: "Releases",
        command: "https://github.com/fatedier/frp/releases",
      },
    ],
  },
  bore: {
    managedWinName: "bore.exe",
    managedPosixName: "bore",
    pathNames: ["bore"],
    versionArgs: ["--version"],
    installCommands: [
      { label: "macOS / Linux (Homebrew)", command: "brew install bore-cli" },
      { label: "Cargo (Rust)", command: "cargo install bore-cli" },
      { label: "Scoop (Windows)", command: "scoop install bore" },
    ],
  },
};

export function toolsDir(): string {
  return (
    process.env.UNIROUTE_TOOLS_DIR?.trim() ||
    path.join(homedir(), ".uniroute", "bin")
  );
}

export function managedTunnelBinaryPath(
  tool: TunnelProviderId,
  platform: NodeJS.Platform = process.platform,
): string {
  const meta = BINARY_META[tool];
  return path.join(
    toolsDir(),
    platform === "win32" ? meta.managedWinName : meta.managedPosixName,
  );
}

function findOnSystemPath(names: string[]): string | null {
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
          // Ignore non-existent PATH entries.
        }
      }
    }
  }
  return null;
}

function resolveConfiguredPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  const hasSep =
    trimmed.includes("/") || trimmed.includes("\\") || trimmed.startsWith(".");
  if (!hasSep) {
    return findOnSystemPath([trimmed]);
  }
  const abs = path.resolve(trimmed);
  try {
    if (existsSync(abs) && statSync(abs).isFile()) return abs;
  } catch {
    // Ignore invalid file handle.
  }
  if (process.platform === "win32") {
    for (const ext of [".exe", ".cmd", ".bat"]) {
      const withExt = `${abs}${ext}`;
      try {
        if (existsSync(withExt) && statSync(withExt).isFile()) return withExt;
      } catch {
        // Ignore missing extension variant.
      }
    }
  }
  return null;
}

export function resolveTunnelBinary(
  tool: TunnelProviderId,
  configuredPath = "",
): {
  resolvedPath: string | null;
  source: TunnelToolSource;
  isManaged: boolean;
} {
  const managed = managedTunnelBinaryPath(tool);
  const resolvedConfigured = resolveConfiguredPath(configuredPath);

  if (resolvedConfigured) {
    const isManaged =
      path.resolve(resolvedConfigured).toLowerCase() ===
      path.resolve(managed).toLowerCase();
    return {
      resolvedPath: resolvedConfigured,
      source: isManaged ? "managed" : "custom",
      isManaged,
    };
  }

  try {
    if (existsSync(managed) && statSync(managed).isFile()) {
      return { resolvedPath: managed, source: "managed", isManaged: true };
    }
  } catch {
    // Fall through to system PATH.
  }

  const fromPath = findOnSystemPath(BINARY_META[tool].pathNames);
  if (fromPath) {
    return { resolvedPath: fromPath, source: "path", isManaged: false };
  }

  return { resolvedPath: null, source: "missing", isManaged: false };
}

type ProbeEntry = {
  ok: boolean;
  version: string | null;
  expiresAt: number;
};

const PROBE_TTL_MS = 30_000;
const probeCache = new Map<string, ProbeEntry>();

export function clearTunnelProbeCache(): void {
  probeCache.clear();
}

function parseVersionOutput(tool: TunnelProviderId, output: string): string | null {
  if (tool === "cloudflared") {
    const m = output.match(/cloudflared\s+version\s+v?([0-9]+\.[0-9]+\.[0-9]+[^\s]*)/i);
    if (m) return m[1]!;
  } else if (tool === "ngrok") {
    const m = output.match(/ngrok\s+version\s+v?([0-9]+\.[0-9]+\.[0-9]+[^\s]*)/i);
    if (m) return m[1]!;
  } else if (tool === "frpc") {
    const m = output.match(/\bv?([0-9]+\.[0-9]+\.[0-9]+[^\s]*)\b/);
    if (m) return m[1]!;
  } else if (tool === "bore") {
    const m = output.match(/bore(?:-cli)?\s+v?([0-9]+\.[0-9]+\.[0-9]+[^\s]*)/i);
    if (m) return m[1]!;
  }
  const fallback = output.match(/v?([0-9]+\.[0-9]+\.[0-9]+)/);
  return fallback ? fallback[1]! : null;
}

export function probeTunnelTool(
  tool: TunnelProviderId,
  resolvedPath: string,
): { ok: boolean; version: string | null } {
  let cacheKey = `${tool}:${resolvedPath}`;
  try {
    const st = statSync(resolvedPath);
    cacheKey = `${tool}:${resolvedPath}:${st.mtimeMs}:${st.size}`;
  } catch {
    return { ok: false, version: null };
  }

  const now = Date.now();
  const cached = probeCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { ok: cached.ok, version: cached.version };
  }

  let ok = false;
  let version: string | null = null;
  try {
    const res = spawnSync(resolvedPath, BINARY_META[tool].versionArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 4_000,
      windowsHide: true,
    });
    const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
    ok = res.status === 0;
    if (ok) {
      version = parseVersionOutput(tool, combined);
    }
  } catch {
    ok = false;
  }

  probeCache.set(cacheKey, { ok, version, expiresAt: now + PROBE_TTL_MS });
  return { ok, version };
}

export function selectCloudflaredAssetCandidates(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string[] {
  if (platform === "win32") {
    if (arch === "x64" || arch === "arm64") {
      return ["cloudflared-windows-amd64.exe"];
    }
    return [];
  }
  if (platform === "linux") {
    if (arch === "x64") return ["cloudflared-linux-amd64"];
    if (arch === "arm64") return ["cloudflared-linux-arm64"];
    return [];
  }
  if (platform === "darwin") {
    if (arch === "arm64") return ["cloudflared-darwin-arm64.tgz"];
    if (arch === "x64") return ["cloudflared-darwin-amd64.tgz"];
  }
  return [];
}

export function selectNgrokAssetCandidates(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { assetName: string; url: string }[] {
  const base = "https://bin.equinox.io/c/bNyj1mQVY4c";
  if (platform === "win32" && arch === "x64") {
    const assetName = "ngrok-v3-stable-windows-amd64.zip";
    return [{ assetName, url: `${base}/${assetName}` }];
  }
  if (platform === "linux" && arch === "x64") {
    const assetName = "ngrok-v3-stable-linux-amd64.tgz";
    return [{ assetName, url: `${base}/${assetName}` }];
  }
  if (platform === "linux" && arch === "arm64") {
    const assetName = "ngrok-v3-stable-linux-arm64.tgz";
    return [{ assetName, url: `${base}/${assetName}` }];
  }
  if (platform === "darwin" && arch === "arm64") {
    const assetName = "ngrok-v3-stable-darwin-arm64.zip";
    return [{ assetName, url: `${base}/${assetName}` }];
  }
  if (platform === "darwin" && arch === "x64") {
    const assetName = "ngrok-v3-stable-darwin-amd64.zip";
    return [{ assetName, url: `${base}/${assetName}` }];
  }
  return [];
}

export function selectFrpcAssetCandidates(
  tag: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string[] {
  const ver = tag.replace(/^v/i, "");
  if (!ver) return [];
  if (platform === "win32" && arch === "x64") {
    return [`frp_${ver}_windows_amd64.zip`];
  }
  if (platform === "linux") {
    if (arch === "x64") return [`frp_${ver}_linux_amd64.tar.gz`];
    if (arch === "arm64") return [`frp_${ver}_linux_arm64.tar.gz`];
    return [];
  }
  if (platform === "darwin") {
    if (arch === "arm64") return [`frp_${ver}_darwin_arm64.tar.gz`];
    if (arch === "x64") return [`frp_${ver}_darwin_amd64.tar.gz`];
  }
  return [];
}

export function selectBoreAssetCandidates(
  tag: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string[] {
  if (!tag) return [];
  if (platform === "win32" && arch === "x64") {
    return [`bore-${tag}-x86_64-pc-windows-msvc.zip`];
  }
  if (platform === "linux") {
    if (arch === "x64") return [`bore-${tag}-x86_64-unknown-linux-musl.tar.gz`];
    if (arch === "arm64") return [`bore-${tag}-aarch64-unknown-linux-musl.tar.gz`];
    return [];
  }
  if (platform === "darwin") {
    if (arch === "arm64") return [`bore-${tag}-aarch64-apple-darwin.tar.gz`];
    if (arch === "x64") return [`bore-${tag}-x86_64-apple-darwin.tar.gz`];
  }
  return [];
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

export function parseFrpChecksumForAsset(
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

function webHeaders(): Record<string, string> {
  return {
    "User-Agent": "uniroute-tunnel-downloader/1.1",
  };
}

function findFileRecursive(dir: string, targetNames: string[]): string | null {
  const wanted = new Set(targetNames.map((n) => n.toLowerCase()));
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && wanted.has(entry.name.toLowerCase())) {
      return full;
    }
    if (entry.isDirectory()) {
      const nested = findFileRecursive(full, targetNames);
      if (nested) return nested;
    }
  }
  return null;
}

function extractArchive(archivePath: string, destDir: string): void {
  const tarArgs = archivePath.endsWith(".zip")
    ? ["-xf", archivePath, "-C", destDir]
    : ["-xzf", archivePath, "-C", destDir];
  const res = spawnSync("tar", tarArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (res.status === 0) return;

  if (process.platform === "win32" && archivePath.endsWith(".zip")) {
    const ps = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      },
    );
    if (ps.status === 0) return;
    throw new Error(
      `Failed to extract archive: ${(ps.stderr ?? "").trim() || "Expand-Archive failed"}`,
    );
  }

  throw new Error(
    `Failed to extract archive: ${(res.stderr ?? "").trim() || `tar exited ${res.status}`}`,
  );
}

// Resolve latest GitHub release tag via redirect + Atom feed to avoid 60 req/hr API limits.
async function resolveGitHubTagNoApi(
  repo: string,
  pinnedEnv?: string,
  atomPrefix?: string,
): Promise<string> {
  if (pinnedEnv) return pinnedEnv;
  const headers = webHeaders();

  try {
    const head = await fetch(`https://github.com/${repo}/releases/latest`, {
      method: "HEAD",
      redirect: "manual",
      headers,
    });
    const tag = extractTagFromRedirect(head.headers.get("location"));
    if (tag) return tag;
  } catch {
    // Fall through to Atom feed.
  }

  const atomRes = await fetch(`https://github.com/${repo}/releases.atom`, {
    headers,
    redirect: "follow",
  });
  if (atomRes.ok) {
    const tag = extractLatestTagFromAtom(await atomRes.text(), atomPrefix);
    if (tag) return tag;
  }

  throw new Error(`Could not determine latest release tag for ${repo}.`);
}

export async function downloadTunnelTool(
  tool: TunnelProviderId,
): Promise<DownloadTunnelToolResult> {
  const headers = webHeaders();
  let tag = "custom";
  let matchedAssetName = "";
  let bytes: Uint8Array | null = null;
  let checksumVerified = false;
  let lastStatus = 0;

  if (tool === "cloudflared") {
    const customUrl = process.env.UNIROUTE_CLOUDFLARED_DOWNLOAD_URL?.trim();
    const candidates = selectCloudflaredAssetCandidates();
    if (!customUrl && candidates.length === 0) {
      throw new Error(
        `No prebuilt cloudflared binary for ${process.platform}/${process.arch}.`,
      );
    }
    if (customUrl) {
      const res = await fetch(customUrl, { headers, redirect: "follow" });
      if (!res.ok) throw new Error(`Custom URL download failed (HTTP ${res.status}).`);
      bytes = new Uint8Array(await res.arrayBuffer());
      matchedAssetName = path.basename(new URL(customUrl).pathname) || candidates[0] || "cloudflared";
    } else {
      tag = await resolveGitHubTagNoApi(
        "cloudflare/cloudflared",
        process.env.UNIROUTE_CLOUDFLARED_VERSION?.trim(),
      );
      for (const candidate of candidates) {
        const url = `https://github.com/cloudflare/cloudflared/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(candidate)}`;
        const res = await fetch(url, { headers, redirect: "follow" });
        lastStatus = res.status;
        if (res.ok) {
          bytes = new Uint8Array(await res.arrayBuffer());
          matchedAssetName = candidate;
          break;
        }
      }
      if (!bytes) {
        throw new Error(
          `Failed to download cloudflared (${tag}, last HTTP ${lastStatus}).`,
        );
      }
    }
  } else if (tool === "ngrok") {
    const customUrl = process.env.UNIROUTE_NGROK_DOWNLOAD_URL?.trim();
    const candidates = selectNgrokAssetCandidates();
    if (!customUrl && candidates.length === 0) {
      throw new Error(
        `No prebuilt ngrok binary for ${process.platform}/${process.arch}.`,
      );
    }
    tag = "v3-stable";
    if (customUrl) {
      const res = await fetch(customUrl, { headers, redirect: "follow" });
      if (!res.ok) throw new Error(`Custom URL download failed (HTTP ${res.status}).`);
      bytes = new Uint8Array(await res.arrayBuffer());
      matchedAssetName = path.basename(new URL(customUrl).pathname) || "ngrok.zip";
    } else {
      for (const candidate of candidates) {
        const res = await fetch(candidate.url, { headers, redirect: "follow" });
        lastStatus = res.status;
        if (res.ok) {
          bytes = new Uint8Array(await res.arrayBuffer());
          matchedAssetName = candidate.assetName;
          break;
        }
      }
      if (!bytes) {
        throw new Error(`Failed to download ngrok (last HTTP ${lastStatus}).`);
      }
    }
  } else if (tool === "frpc") {
    const customUrl = process.env.UNIROUTE_FRPC_DOWNLOAD_URL?.trim();
    if (customUrl) {
      const res = await fetch(customUrl, { headers, redirect: "follow" });
      if (!res.ok) throw new Error(`Custom URL download failed (HTTP ${res.status}).`);
      bytes = new Uint8Array(await res.arrayBuffer());
      matchedAssetName = path.basename(new URL(customUrl).pathname) || "frpc.tar.gz";
    } else {
      tag = await resolveGitHubTagNoApi(
        "fatedier/frp",
        process.env.UNIROUTE_FRPC_VERSION?.trim(),
        "v",
      );
      const candidates = selectFrpcAssetCandidates(tag);
      if (candidates.length === 0) {
        throw new Error(
          `No prebuilt frpc binary for ${process.platform}/${process.arch}.`,
        );
      }
      for (const candidate of candidates) {
        const url = `https://github.com/fatedier/frp/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(candidate)}`;
        const res = await fetch(url, { headers, redirect: "follow" });
        lastStatus = res.status;
        if (res.ok) {
          bytes = new Uint8Array(await res.arrayBuffer());
          matchedAssetName = candidate;
          break;
        }
      }
      if (!bytes) {
        throw new Error(
          `Failed to download frpc (${tag}, last HTTP ${lastStatus}).`,
        );
      }
    }
  } else {
    const customUrl = process.env.UNIROUTE_BORE_DOWNLOAD_URL?.trim();
    if (customUrl) {
      const res = await fetch(customUrl, { headers, redirect: "follow" });
      if (!res.ok) throw new Error(`Custom URL download failed (HTTP ${res.status}).`);
      bytes = new Uint8Array(await res.arrayBuffer());
      matchedAssetName = path.basename(new URL(customUrl).pathname) || "bore.tar.gz";
    } else {
      tag = await resolveGitHubTagNoApi(
        "ekzhang/bore",
        process.env.UNIROUTE_BORE_VERSION?.trim(),
        "v",
      );
      const candidates = selectBoreAssetCandidates(tag);
      if (candidates.length === 0) {
        throw new Error(
          `No prebuilt bore binary for ${process.platform}/${process.arch}.`,
        );
      }
      for (const candidate of candidates) {
        const url = `https://github.com/ekzhang/bore/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(candidate)}`;
        const res = await fetch(url, { headers, redirect: "follow" });
        lastStatus = res.status;
        if (res.ok) {
          bytes = new Uint8Array(await res.arrayBuffer());
          matchedAssetName = candidate;
          break;
        }
      }
      if (!bytes) {
        throw new Error(
          `Failed to download bore (${tag}, last HTTP ${lastStatus}).`,
        );
      }
    }
  }

  const actualSha = sha256Hex(bytes);

  if (tool === "frpc" && tag !== "custom") {
    try {
      const csUrl = `https://github.com/fatedier/frp/releases/download/${encodeURIComponent(tag)}/frp_sha256_checksums.txt`;
      const csRes = await fetch(csUrl, { headers, redirect: "follow" });
      if (csRes.ok) {
        const expected = parseFrpChecksumForAsset(await csRes.text(), matchedAssetName);
        if (expected) {
          if (expected !== actualSha) {
            throw new Error(
              `SHA-256 mismatch for ${matchedAssetName} (expected ${expected.slice(0, 12)}..., got ${actualSha.slice(0, 12)}...). Download aborted.`,
            );
          }
          checksumVerified = true;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("SHA-256 mismatch")) {
        throw err;
      }
    }
  }

  const destDir = toolsDir();
  mkdirSync(destDir, { recursive: true });
  const targetPath = managedTunnelBinaryPath(tool);
  const tmpDir = mkdtempSync(path.join(destDir, `.dl-${tool}-`));

  try {
    let sourceBinPath: string;
    const isArchive =
      matchedAssetName.endsWith(".zip") ||
      matchedAssetName.endsWith(".tar.gz") ||
      matchedAssetName.endsWith(".tgz");

    if (isArchive) {
      const archivePath = path.join(tmpDir, matchedAssetName);
      writeFileSync(archivePath, bytes);
      const extractDir = path.join(tmpDir, "extract");
      mkdirSync(extractDir, { recursive: true });
      extractArchive(archivePath, extractDir);
      const wanted =
        process.platform === "win32"
          ? [BINARY_META[tool].managedWinName, BINARY_META[tool].managedPosixName]
          : [BINARY_META[tool].managedPosixName];
      const found = findFileRecursive(extractDir, wanted);
      if (!found) {
        throw new Error(
          `Downloaded archive ${matchedAssetName} did not contain ${wanted.join(" or ")}.`,
        );
      }
      sourceBinPath = found;
    } else {
      sourceBinPath = path.join(tmpDir, path.basename(targetPath));
      writeFileSync(sourceBinPath, bytes);
    }

    const staging = `${targetPath}.tmp-${process.pid}`;
    copyFileSync(sourceBinPath, staging);
    if (process.platform !== "win32") {
      chmodSync(staging, 0o755);
    }
    renameSync(staging, targetPath);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  clearTunnelProbeCache();
  const probed = probeTunnelTool(tool, targetPath);
  if (!probed.ok) {
    throw new Error(
      `Downloaded ${matchedAssetName}, but binary check failed at ${targetPath}.`,
    );
  }

  return {
    tool,
    tag,
    assetName: matchedAssetName,
    binaryPath: targetPath,
    version: probed.version ?? tag.replace(/^v/i, ""),
    sha256: actualSha,
    checksumVerified,
    sizeBytes: statSync(targetPath).size,
  };
}

export function uninstallTunnelTool(tool: TunnelProviderId): {
  removed: boolean;
  path: string;
} {
  const target = managedTunnelBinaryPath(tool);
  if (!existsSync(target)) {
    return { removed: false, path: target };
  }
  unlinkSync(target);
  clearTunnelProbeCache();
  return { removed: true, path: target };
}

export function getAllTunnelToolsStatus(
  configuredPaths: Partial<Record<TunnelProviderId, string>> = {},
): TunnelToolStatus[] {
  return TUNNEL_PROVIDERS.map((provider) => {
    const meta = BINARY_META[provider.id];
    const configuredPath = (configuredPaths[provider.id] ?? "").trim();
    const managedPath = managedTunnelBinaryPath(provider.id);
    const { resolvedPath, source, isManaged } = resolveTunnelBinary(
      provider.id,
      configuredPath,
    );

    let installed = false;
    let version: string | null = null;
    let sizeBytes: number | null = null;

    if (resolvedPath) {
      const probed = probeTunnelTool(provider.id, resolvedPath);
      installed = probed.ok;
      version = probed.version;
      try {
        sizeBytes = statSync(resolvedPath).size;
      } catch {
        sizeBytes = null;
      }
    }

    return {
      ...provider,
      installed,
      isManaged,
      source,
      resolvedPath,
      configuredPath,
      managedPath,
      version,
      sizeBytes,
      installCommands: meta.installCommands,
    };
  });
}
