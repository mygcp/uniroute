// Entrypoint for standalone compiled binaries (embeds client assets via Bun file imports).
// @ts-expect-error generated at build time by react-router buildEnd
import embeddedAssets from "../build/client-assets.js";
import { main } from "./uni";

(globalThis as { __UNIROUTE_EMBEDDED_ASSETS__?: Record<string, string> }).__UNIROUTE_EMBEDDED_ASSETS__ =
  embeddedAssets ?? {};

main().catch((e) => {
  console.error(`[uni] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
