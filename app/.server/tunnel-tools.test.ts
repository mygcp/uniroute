import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  clearTunnelProbeCache,
  extractLatestTagFromAtom,
  extractTagFromRedirect,
  managedTunnelBinaryPath,
  parseFrpChecksumForAsset,
  probeTunnelTool,
  selectBoreAssetCandidates,
  selectCloudflaredAssetCandidates,
  selectFrpcAssetCandidates,
  selectNgrokAssetCandidates,
  uninstallTunnelTool,
} from "./tunnel-tools";

describe("tunnel-tools helpers", () => {
  test("selects cloudflared release assets across OS and arch", () => {
    expect(selectCloudflaredAssetCandidates("win32", "x64")).toEqual([
      "cloudflared-windows-amd64.exe",
    ]);
    expect(selectCloudflaredAssetCandidates("win32", "arm64")).toEqual([
      "cloudflared-windows-amd64.exe",
    ]);
    expect(selectCloudflaredAssetCandidates("linux", "x64")).toEqual([
      "cloudflared-linux-amd64",
    ]);
    expect(selectCloudflaredAssetCandidates("linux", "arm64")).toEqual([
      "cloudflared-linux-arm64",
    ]);
    expect(selectCloudflaredAssetCandidates("darwin", "arm64")).toEqual([
      "cloudflared-darwin-arm64.tgz",
    ]);
    expect(selectCloudflaredAssetCandidates("darwin", "x64")).toEqual([
      "cloudflared-darwin-amd64.tgz",
    ]);
  });

  test("selects ngrok release assets across OS and arch", () => {
    expect(selectNgrokAssetCandidates("win32", "x64")[0]?.assetName).toBe(
      "ngrok-v3-stable-windows-amd64.zip",
    );
    expect(selectNgrokAssetCandidates("linux", "x64")[0]?.assetName).toBe(
      "ngrok-v3-stable-linux-amd64.tgz",
    );
    expect(selectNgrokAssetCandidates("linux", "arm64")[0]?.assetName).toBe(
      "ngrok-v3-stable-linux-arm64.tgz",
    );
    expect(selectNgrokAssetCandidates("darwin", "arm64")[0]?.assetName).toBe(
      "ngrok-v3-stable-darwin-arm64.zip",
    );
    expect(selectNgrokAssetCandidates("darwin", "x64")[0]?.assetName).toBe(
      "ngrok-v3-stable-darwin-amd64.zip",
    );
  });

  test("selects frpc release assets across OS and arch", () => {
    expect(selectFrpcAssetCandidates("v0.72.0", "win32", "x64")).toEqual([
      "frp_0.72.0_windows_amd64.zip",
    ]);
    expect(selectFrpcAssetCandidates("v0.72.0", "linux", "x64")).toEqual([
      "frp_0.72.0_linux_amd64.tar.gz",
    ]);
    expect(selectFrpcAssetCandidates("v0.72.0", "linux", "arm64")).toEqual([
      "frp_0.72.0_linux_arm64.tar.gz",
    ]);
    expect(selectFrpcAssetCandidates("v0.72.0", "darwin", "arm64")).toEqual([
      "frp_0.72.0_darwin_arm64.tar.gz",
    ]);
    expect(selectFrpcAssetCandidates("v0.72.0", "darwin", "x64")).toEqual([
      "frp_0.72.0_darwin_amd64.tar.gz",
    ]);
  });

  test("selects bore release assets across OS and arch", () => {
    expect(selectBoreAssetCandidates("v0.6.0", "win32", "x64")).toEqual([
      "bore-v0.6.0-x86_64-pc-windows-msvc.zip",
    ]);
    expect(selectBoreAssetCandidates("v0.6.0", "linux", "x64")).toEqual([
      "bore-v0.6.0-x86_64-unknown-linux-musl.tar.gz",
    ]);
    expect(selectBoreAssetCandidates("v0.6.0", "linux", "arm64")).toEqual([
      "bore-v0.6.0-aarch64-unknown-linux-musl.tar.gz",
    ]);
    expect(selectBoreAssetCandidates("v0.6.0", "darwin", "arm64")).toEqual([
      "bore-v0.6.0-aarch64-apple-darwin.tar.gz",
    ]);
    expect(selectBoreAssetCandidates("v0.6.0", "darwin", "x64")).toEqual([
      "bore-v0.6.0-x86_64-apple-darwin.tar.gz",
    ]);
  });

  test("extracts tags from GitHub redirect and Atom feed", () => {
    expect(
      extractTagFromRedirect("https://github.com/cloudflare/cloudflared/releases/tag/2026.11.2"),
    ).toBe("2026.11.2");
    expect(extractTagFromRedirect(null)).toBeNull();

    const atom = `
      <feed>
        <entry><link href="https://github.com/fatedier/frp/releases/tag/v0.72.0" /></entry>
        <entry><link href="https://github.com/fatedier/frp/releases/tag/v0.71.0" /></entry>
      </feed>
    `;
    expect(extractLatestTagFromAtom(atom, "v")).toBe("v0.72.0");
  });

  test("parses frp_sha256_checksums.txt accurately", () => {
    const sample = [
      "# checksums",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  ./frp_0.72.0_windows_amd64.zip",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  frp_0.72.0_linux_arm64.tar.gz",
    ].join("\n");
    expect(parseFrpChecksumForAsset(sample, "frp_0.72.0_windows_amd64.zip")).toBe(
      "a".repeat(64),
    );
    expect(parseFrpChecksumForAsset(sample, "frp_0.72.0_linux_arm64.tar.gz")).toBe(
      "b".repeat(64),
    );
    expect(parseFrpChecksumForAsset(sample, "missing.zip")).toBeNull();
  });

  test("resolves managed binary paths and safely handles missing probes", async () => {
    const prev = process.env.UNIROUTE_TOOLS_DIR;
    process.env.UNIROUTE_TOOLS_DIR = "/tmp/uniroute-tunnel-tools-test";
    try {
      expect(managedTunnelBinaryPath("cloudflared", "win32")).toBe(
        path.join("/tmp/uniroute-tunnel-tools-test", "cloudflared.exe"),
      );
      expect(managedTunnelBinaryPath("frpc", "linux")).toBe(
        path.join("/tmp/uniroute-tunnel-tools-test", "frpc"),
      );
      expect(uninstallTunnelTool("bore").removed).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.UNIROUTE_TOOLS_DIR;
      else process.env.UNIROUTE_TOOLS_DIR = prev;
    }
    clearTunnelProbeCache();
    expect((await probeTunnelTool("cloudflared", "/nonexistent/cloudflared")).ok).toBe(false);
  });
});
