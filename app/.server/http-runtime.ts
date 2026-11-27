import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";

export type HttpServerHandle = {
  readonly port: number;
  readonly hostname: string;
  stop: (force?: boolean) => void;
};

export type HttpServerOptions = {
  port: number;
  hostname: string;
  maxRequestBodySize?: number;
  fetch: (request: Request, peerIp: string | null) => Promise<Response> | Response;
};

function nodeHeadersToWebHeaders(raw: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function incomingToWebRequest(
  req: http.IncomingMessage,
  fallbackHost: string,
  maxBodyBytes: number,
): Request {
  const host = req.headers.host || fallbackHost;
  const rawUrl = req.url || "/";
  const url = rawUrl.startsWith("http://") || rawUrl.startsWith("https://")
    ? rawUrl
    : `http://${host}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`;
  const method = (req.method || "GET").toUpperCase();
  const headers = nodeHeadersToWebHeaders(req.headers);

  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }

  let received = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      req.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
        if (maxBodyBytes > 0 && received > maxBodyBytes) {
          req.destroy(new Error("Request body too large"));
          controller.error(new Error("Request body too large"));
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
      });
      req.on("end", () => {
        try {
          controller.close();
        } catch {
          // ignore already closed stream
        }
      });
      req.on("error", (err) => {
        try {
          controller.error(err);
        } catch {
          // ignore
        }
      });
    },
    cancel() {
      req.destroy();
    },
  });

  return new Request(url, {
    method,
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

async function writeWebResponse(
  res: http.ServerResponse,
  response: Response,
  isHead: boolean,
): Promise<void> {
  if (res.writableEnded) return;
  res.statusCode = response.status;
  if (response.statusText) res.statusMessage = response.statusText;

  const setCookies = response.headers.getSetCookie?.() ?? [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    res.setHeader(key, value);
  });
  if (setCookies.length > 0) {
    res.setHeader("Set-Cookie", setCookies);
  }

  if (isHead || !response.body) {
    res.end();
    return;
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/event-stream")) {
    res.flushHeaders?.();
  }

  const nodeStream = Readable.fromWeb(
    response.body as unknown as import("node:stream/web").ReadableStream,
  );
  await new Promise<void>((resolve) => {
    const cleanup = () => {
      nodeStream.off("error", onError);
      res.off("close", onClose);
      res.off("finish", onFinish);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      nodeStream.destroy();
      resolve();
    };
    const onError = () => {
      cleanup();
      if (!res.writableEnded) res.end();
      resolve();
    };
    nodeStream.once("error", onError);
    res.once("close", onClose);
    res.once("finish", onFinish);
    nodeStream.pipe(res);
  });
}

export function startHttpServer(opts: HttpServerOptions): HttpServerHandle {
  if (typeof Bun !== "undefined") {
    const srv = Bun.serve({
      port: opts.port,
      hostname: opts.hostname,
      maxRequestBodySize: opts.maxRequestBodySize,
      fetch(request, serverRef) {
        const peerIp = serverRef?.requestIP?.(request)?.address ?? null;
        return opts.fetch(request, peerIp);
      },
    });
    return {
      get port() {
        return Number(srv.port ?? opts.port);
      },
      get hostname() {
        return String(srv.hostname ?? opts.hostname);
      },
      stop(force?: boolean) {
        srv.stop(force);
      },
    };
  }

  const maxBodyBytes = opts.maxRequestBodySize ?? 32 * 1024 * 1024;
  const fallbackHost = `${opts.hostname}:${opts.port || 3000}`;

  const server = http.createServer((req, res) => {
    const isHead = (req.method || "GET").toUpperCase() === "HEAD";
    const peerIp = req.socket?.remoteAddress ?? null;
    let webReq: Request;
    try {
      webReq = incomingToWebRequest(req, fallbackHost, maxBodyBytes);
    } catch {
      res.statusCode = 400;
      res.end("Bad Request");
      return;
    }

    Promise.resolve(opts.fetch(webReq, peerIp))
      .then((webRes) => writeWebResponse(res, webRes, isHead))
      .catch((err) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        res.statusCode = msg.includes("too large") ? 413 : 500;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(res.statusCode === 413 ? "Payload Too Large" : "Internal Server Error");
      });
  });

  server.listen(opts.port, opts.hostname);

  return {
    get port() {
      const addr = server.address();
      if (addr && typeof addr === "object") return addr.port;
      return opts.port;
    },
    get hostname() {
      const addr = server.address();
      if (addr && typeof addr === "object") return addr.address;
      return opts.hostname;
    },
    stop(force?: boolean) {
      if (force && typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      server.close();
    },
  };
}

export function gzipBytes(data: Uint8Array): Uint8Array {
  if (typeof Bun !== "undefined") {
    return Bun.gzipSync(Buffer.from(data));
  }
  return new Uint8Array(zlib.gzipSync(data));
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function whichBin(name: string): string | null {
  if (typeof Bun !== "undefined") {
    const found = Bun.which(name);
    if (found) return found;
  }
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const isWin = process.platform === "win32";
  const exts = isWin
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
        .split(";")
        .filter(Boolean)
        .map((e) => e.toLowerCase())
    : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate =
        isWin && !name.toLowerCase().endsWith(ext)
          ? path.join(dir, `${name}${ext}`)
          : path.join(dir, name);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile()) return candidate;
      } catch {
        // ignore missing candidate
      }
    }
  }
  return null;
}

export function probeEphemeralPort(hostname = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, hostname, () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
