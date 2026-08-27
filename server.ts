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

function resolveClientDir(): string {
  const candidates = [
    path.join(import.meta.dir, "build", "client"),
    path.join(process.cwd(), "build", "client"),
    path.join(path.dirname(process.execPath), "build", "client"),
  ];
  for (const c of candidates) {
    try {
      // best-effort sync check — if exists use it
      if (Bun.file(path.join(c, "favicon.ico")).size !== undefined) return c;
    } catch {}
  }
  return candidates[0];
}

export type StartOpts = {
  port?: number;
  hostname?: string;
  onReady?: (info: { port: number; hostname: string }) => void;
};

export function startServer(opts: StartOpts = {}) {
  const clientDir = resolveClientDir();
  const port = Number(opts.port ?? process.env.PORT ?? 3000);
  const hostname = opts.hostname ?? process.env.HOST ?? "0.0.0.0";

  const server = Bun.serve({
    port,
    hostname,
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

  console.log(`UniRoute listening on http://${server.hostname}:${server.port}`);
  if (opts.onReady) opts.onReady({ port: server.port as number, hostname: server.hostname as string });

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

  return server;
}

// Auto-start bila dijalankan langsung: `bun server.ts` atau `bun run start`
if (import.meta.main) {
  startServer();
}