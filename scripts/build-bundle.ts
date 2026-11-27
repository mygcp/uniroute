import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pkg from "../package.json";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "dist", "bundle");
const ARCHIVE_PATH = path.join(ROOT, "dist", "uni-bundle.tar.gz");

function runBunBuild(args: string[]) {
  const proc = spawnSync(process.execPath, ["build", ...args], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (proc.status !== 0) {
    throw new Error(`bun build failed with exit code ${proc.status ?? 1}`);
  }
}

function main() {
  if (!fs.existsSync(path.join(ROOT, "build", "server", "index.js"))) {
    throw new Error("build/server/index.js is missing. Run 'bun run build' first.");
  }
  if (!fs.existsSync(path.join(ROOT, "build", "client"))) {
    throw new Error("build/client is missing. Run 'bun run build' first.");
  }

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  runBunBuild([
    "cli/uni.ts",
    "--target=node",
    "--format=esm",
    "--splitting",
    "--minify",
    "--sourcemap=none",
    "--external:bun:sqlite",
    "--external:node:sqlite",
    "--outdir",
    OUT_DIR,
    "--entry-naming=[name].mjs",
    "--chunk-naming=chunks/[name]-[hash].mjs",
  ]);

  runBunBuild([
    "app/.server/mcp-server.ts",
    "--target=node",
    "--format=esm",
    "--minify",
    "--sourcemap=none",
    "--external:bun:sqlite",
    "--external:node:sqlite",
    "--outfile",
    path.join(OUT_DIR, "mcp-server.mjs"),
  ]);

  fs.cpSync(path.join(ROOT, "build", "client"), path.join(OUT_DIR, "client"), {
    recursive: true,
  });

  fs.writeFileSync(
    path.join(OUT_DIR, "package.json"),
    JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        private: true,
        type: "module",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  fs.rmSync(ARCHIVE_PATH, { force: true });
  const tarProc = spawnSync(
    "tar",
    ["-czf", ARCHIVE_PATH, "-C", OUT_DIR, "."],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (tarProc.status !== 0) {
    throw new Error(`tar failed with exit code ${tarProc.status ?? 1}`);
  }

  const sizeBytes = fs.statSync(ARCHIVE_PATH).size;
  console.log(
    `[bundle] created ${path.relative(ROOT, ARCHIVE_PATH)} (${(sizeBytes / 1024).toFixed(1)} KB)`,
  );
}

main();
