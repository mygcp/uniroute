import { createRequestHandler } from "react-router";
import type { ServerBuild } from "react-router";
import path from "node:path";
// @ts-expect-error — build artifact generated at build time
import * as build from "./build/server/index.js";

const serverBuild = build as unknown as ServerBuild;

const requestHandler = createRequestHandler(serverBuild, "production");

const clientDir = path.join(import.meta.dir, "build", "client");
const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET") {
      const filePath = path.join(clientDir, pathname);
      if (filePath.startsWith(clientDir)) {
        const file = Bun.file(filePath);
        if (await file.exists()) {
          return new Response(file);
        }
      }
    }
    return requestHandler(request);
  },
});

console.log(`UniRoute listening on http://localhost:${server.port}`);

function shutdown(signal: string) {
  console.log(`[server] ${signal} received, shutting down...`);
  server.stop(true);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));