import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findBinaryAsset,
  getInstallInfo,
  isValidReleaseTarget,
  normalizeTagVersion,
  parseGitHubReleases,
  resolveExtractedBundleRoot,
  swapBundleDirectory,
} from "./self-update";

describe("self-update helpers", () => {
  test("normalizeTagVersion strips leading v", () => {
    expect(normalizeTagVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeTagVersion("1.2.3")).toBe("1.2.3");
    expect(normalizeTagVersion("  v2.0.0-rc.1  ")).toBe("2.0.0-rc.1");
  });

  test("isValidReleaseTarget validates safe tags and latest", () => {
    expect(isValidReleaseTarget("latest")).toBe(true);
    expect(isValidReleaseTarget("v1.1.0")).toBe(true);
    expect(isValidReleaseTarget("1.2.0-beta.1")).toBe(true);
    expect(isValidReleaseTarget("")).toBe(false);
    expect(isValidReleaseTarget("../evil")).toBe(false);
    expect(isValidReleaseTarget("v1.0/../../x")).toBe(false);
    expect(isValidReleaseTarget("tag with spaces")).toBe(false);
  });

  test("findBinaryAsset prefers archive over raw binary", () => {
    const assets = [
      { name: "uni-linux-x64", browser_download_url: "https://example.com/raw" },
      { name: "uni-linux-x64.tar.gz", browser_download_url: "https://example.com/tgz" },
    ];
    expect(findBinaryAsset(assets, "linux", "x64")?.name).toBe("uni-linux-x64.tar.gz");
    expect(findBinaryAsset(assets, "win32", "x64")).toBeNull();
  });

  test("parseGitHubReleases filters drafts, marks latest and current", () => {
    const parsed = parseGitHubReleases(
      [
        { tag_name: "v1.3.0-draft", draft: true, assets: [] },
        {
          tag_name: "v1.2.0-rc.1",
          prerelease: true,
          published_at: "2026-11-25T00:00:00Z",
          assets: [{ name: "uni-bundle.tar.gz", browser_download_url: "https://x/b.tgz", size: 500_000 }],
        },
        {
          tag_name: "v1.1.0",
          prerelease: false,
          published_at: "2026-11-20T00:00:00Z",
          assets: [
            { name: "uni-bundle.tar.gz", browser_download_url: "https://x/b2.tgz", size: 480_000 },
            { name: "uni-linux-x64.tar.gz", browser_download_url: "https://x/l.tgz", size: 30_000_000 },
          ],
        },
      ],
      "1.1.0",
      "linux",
      "x64",
    );

    expect(parsed).toHaveLength(2);
    expect(parsed[0].tag).toBe("v1.2.0-rc.1");
    expect(parsed[0].isLatest).toBe(false);
    expect(parsed[0].hasBundleAsset).toBe(true);
    expect(parsed[0].hasBinaryAsset).toBe(false);

    expect(parsed[1].tag).toBe("v1.1.0");
    expect(parsed[1].isLatest).toBe(true);
    expect(parsed[1].isCurrent).toBe(true);
    expect(parsed[1].hasBundleAsset).toBe(true);
    expect(parsed[1].hasBinaryAsset).toBe(true);
  });

  test("getInstallInfo detects source mode in repo checkout", () => {
    const info = getInstallInfo();
    expect(info.installMode).toBe("source");
    expect(info.canSelfUpdate).toBe(false);
    expect(info.currentVersion.length).toBeGreaterThan(0);
  });

  test("resolveExtractedBundleRoot and swapBundleDirectory replace app atomically", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uniroute-swap-test-"));
    try {
      const appDir = path.join(tmp, "app");
      fs.mkdirSync(path.join(appDir, "client"), { recursive: true });
      fs.writeFileSync(path.join(appDir, "uni.mjs"), "console.log('old');");

      const extractDir = path.join(tmp, "extract");
      fs.mkdirSync(path.join(extractDir, "bundle", "client"), { recursive: true });
      fs.writeFileSync(path.join(extractDir, "bundle", "uni.mjs"), "console.log('new');");

      const root = resolveExtractedBundleRoot(extractDir);
      swapBundleDirectory(root, appDir);

      expect(fs.readFileSync(path.join(appDir, "uni.mjs"), "utf8")).toContain("new");
      expect(fs.readFileSync(path.join(`${appDir}.bak`, "uni.mjs"), "utf8")).toContain("old");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
