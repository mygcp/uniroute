import fs from "node:fs";
import path from "node:path";
import type { Config } from "@react-router/dev/config";

function collectFiles(dir: string, base: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full, base));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out;
}

export default {
  ssr: true,
  buildEnd({ reactRouterConfig }) {
    const buildDir = reactRouterConfig.buildDirectory;
    const clientDir = path.join(buildDir, "client");
    if (!fs.existsSync(clientDir)) return;

    const files = collectFiles(clientDir, clientDir).sort();
    const imports = files.map(
      (rel, i) => `import a${i} from ${JSON.stringify(`./client/${rel}`)} with { type: "file" };`,
    );
    const entries = files.map((rel, i) => `  ${JSON.stringify(`/${rel}`)}: a${i},`);
    const content = [...imports, "export default {", ...entries, "};", ""].join("\n");
    fs.writeFileSync(path.join(buildDir, "client-assets.js"), content, "utf8");
  },
} satisfies Config;
