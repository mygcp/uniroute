import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearProbeCache,
  extractLatestTagFromAtom,
  extractTagFromRedirect,
  isLegacyStubPath,
  parseChecksumForAsset,
  probeTool,
  selectCavemanAssetCandidates,
  selectRtkAssetCandidates,
  uninstallTool,
} from "./compressor-tools";

describe("compressor-tools helpers", () => {
  test("selects correct RTK release assets per platform/arch", () => {
    expect(selectRtkAssetCandidates("win32", "x64")[0]).toBe(
      "rtk-oss-x86_64-pc-windows-msvc.zip",
    );
    expect(selectRtkAssetCandidates("darwin", "arm64")[0]).toBe(
      "rtk-oss-aarch64-apple-darwin.tar.gz",
    );
    expect(selectRtkAssetCandidates("linux", "x64")[0]).toBe(
      "rtk-oss-x86_64-unknown-linux-musl.tar.gz",
    );
    expect(selectRtkAssetCandidates("linux", "arm64")[0]).toBe(
      "rtk-oss-aarch64-unknown-linux-musl.tar.gz",
    );
  });

  test("selects correct Caveman Engine release assets per platform/arch", () => {
    expect(selectCavemanAssetCandidates("win32", "x64")).toEqual([
      "caveman-engine_win32_amd64",
    ]);
    expect(selectCavemanAssetCandidates("darwin", "arm64")).toEqual([
      "caveman-engine_darwin_arm64",
    ]);
    expect(selectCavemanAssetCandidates("linux", "x64")).toEqual([
      "caveman-engine_linux_amd64",
    ]);
    expect(selectCavemanAssetCandidates("linux", "arm64")).toEqual([
      "caveman-engine_linux_arm64",
    ]);
  });

  test("parses SHA-256 checksums.txt formats accurately", () => {
    const sample = [
      "# comment",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  rtk-oss-x86_64-pc-windows-msvc.zip",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb *./caveman-engine_win32_amd64",
    ].join("\n");
    expect(
      parseChecksumForAsset(sample, "rtk-oss-x86_64-pc-windows-msvc.zip"),
    ).toBe("a".repeat(64));
    expect(
      parseChecksumForAsset(sample, "caveman-engine_win32_amd64"),
    ).toBe("b".repeat(64));
    expect(parseChecksumForAsset(sample, "missing.zip")).toBeNull();
  });

  test("resolves release tags from redirects and Atom feeds without GitHub API", () => {
    expect(
      extractTagFromRedirect("https://github.com/rtk-ai/rtk/releases/tag/v1.2.1"),
    ).toBe("v1.2.1");
    expect(extractTagFromRedirect(null)).toBeNull();

    const atom = `
      <entry><link href="https://github.com/JuliusBrussee/caveman/releases/tag/v4.2.0"/></entry>
      <entry><link href="https://github.com/JuliusBrussee/caveman/releases/tag/bin-v4.2.0"/></entry>
    `;
    expect(extractLatestTagFromAtom(atom, "bin-v")).toBe("bin-v4.2.0");
    expect(extractLatestTagFromAtom(atom, "v")).toBe("v4.2.0");
  });

  test("identifies legacy mock stubs without treating them as installed tools", () => {
    expect(isLegacyStubPath("./bin/rtk")).toBe(true);
    expect(isLegacyStubPath("./bin/caveman")).toBe(true);
    expect(isLegacyStubPath("C:\\Users\\user\\.uniroute\\bin\\rtk.exe")).toBe(false);

    const prevDir = process.env.UNIROUTE_TOOLS_DIR;
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "uniroute-tools-test-"));
    process.env.UNIROUTE_TOOLS_DIR = tmpDir;
    clearProbeCache();
    try {
      const rtkStub = probeTool("rtk", "./bin/rtk");
      // If rtk is not on system PATH, ./bin/rtk is honestly flagged as stub
      if (rtkStub.source === "stub") {
        expect(rtkStub.isStub).toBe(true);
        expect(rtkStub.installed).toBe(false);
      }
      expect(uninstallTool("rtk").removed).toBe(false);
    } finally {
      if (prevDir === undefined) delete process.env.UNIROUTE_TOOLS_DIR;
      else process.env.UNIROUTE_TOOLS_DIR = prevDir;
      rmSync(tmpDir, { recursive: true, force: true });
      clearProbeCache();
    }
  });
});
