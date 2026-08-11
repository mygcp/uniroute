import { createRequestHandler } from "react-router";
import type { ServerBuild } from "react-router";
import path from "node:path";
import { closeDb } from "./app/.server/db";
import { flushLogs } from "./app/.server/logger";
import { startWebhookDeliverer, stopWebhookDeliverer } from "./app/.server/webhook";
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

startWebhookDeliverer();

let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down...`);

  // Force exit bila melebihi 5s (DoD graceful shutdown ≤ 5s).
  const force = setTimeout(() => {
    console.error("[server] shutdown timeout, forcing exit");
    process.exit(1);
  }, 5000);

  Promise.resolve()
    .then(() => stopWebhookDeliverer())
    .then(() => server.stop(true))
    .then(() => flushLogs())
    .then(() => closeDb())
    .then(() => {
      clearTimeout(force);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[server] shutdown error", err);
      process.exit(1);
    });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));