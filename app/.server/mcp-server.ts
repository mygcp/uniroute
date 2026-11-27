/**
 * UniRoute MCP Server.
 *
 * Two transports:
 *  1. stdio (default): JSON-RPC per line on stdin/stdout for spawned agent CLIs.
 *  2. HTTP POST /mcp (--http [port]): single JSON-RPC per request for remote agents.
 *     Optional bearer token via UNIROUTE_MCP_TOKEN.
 *
 * All tools operate directly on the shared gateway SQLite database.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

// Pin data to the UniRoute root regardless of the agent process CWD so spawned
// processes never open an empty SQLite file in another directory.
import { timingSafeStringEqual } from "./auth";
import { startHttpServer } from "./http-runtime";
const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.DATABASE_URL ??= path.resolve(HERE, "../../data/uniroute.db");

const { executeTool, TOOLS } = await import("./mcp-tools");

type RpcRequest = {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: Record<string, unknown>;
};

const SERVER_INFO = { name: "uniroute", version: "1.1.0" };

class RpcError extends Error {
	constructor(
		public code: number,
		message: string,
	) {
		super(message);
	}
}

/** Process one JSON-RPC message into a response or RpcError. Null means notification. */
async function processMessage(
	msg: RpcRequest,
): Promise<{ id: unknown; result?: unknown; error?: { code: number; message: string } } | null> {
	const { id, method } = msg;
	if (id === undefined || id === null) return null; // notification

	switch (method) {
		case "initialize":
			return {
				id,
				result: {
					protocolVersion:
						(msg.params?.protocolVersion as string) ?? "2025-06-18",
					capabilities: { tools: { listChanged: false } },
					serverInfo: SERVER_INFO,
				},
			};
		case "ping":
			return { id, result: {} };
		case "tools/list":
			return { id, result: { tools: TOOLS } };
		case "tools/call": {
			const params = msg.params ?? {};
			const name = String(params.name ?? "");
			const args =
				params.arguments && typeof params.arguments === "object"
					? (params.arguments as Record<string, unknown>)
					: {};
			try {
				const out = await executeTool(name, args);
				return {
					id,
					result: { content: out.content, isError: out.isError === true },
				};
			} catch (err) {
				throw new RpcError(
					-32603,
					err instanceof Error ? err.message : String(err),
				);
			}
		}
		case "resources/list":
			return { id, result: { resources: [] } };
		case "prompts/list":
			return { id, result: { prompts: [] } };
		default:
			throw new RpcError(-32601, `Method not found: ${method ?? ""}`);
	}
}

function frame(id: unknown, payload: object): string {
	return (
		JSON.stringify({
			jsonrpc: "2.0",
			id,
			...(payload as Record<string, unknown>),
		}) + "\n"
	);
}

/* ------------------------------- stdio mode ------------------------------- */

async function runStdio(): Promise<void> {
	let buffer = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		buffer += chunk;
		let idx: number;
		while ((idx = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, idx).trim();
			buffer = buffer.slice(idx + 1);
			if (line === "") continue;
			let msg: RpcRequest;
			try {
				msg = JSON.parse(line) as RpcRequest;
			} catch {
				process.stdout.write(
					JSON.stringify({
						jsonrpc: "2.0",
						id: null,
						error: { code: -32700, message: "Parse error" },
					}) + "\n",
				);
				continue;
			}
			void processMessage(msg)
				.then((out) => {
					if (!out) return;
					if (out.error) {
						process.stdout.write(
							frame(out.id, { error: out.error }),
						);
					} else {
						process.stdout.write(frame(out.id, { result: out.result }));
					}
				})
				.catch(() => {});
		}
	});
	process.stdin.on("end", () => process.exit(0));
}

/* -------------------------------- http mode ------------------------------- */

async function runHttp(port: number): Promise<void> {
	const token = process.env.UNIROUTE_MCP_TOKEN?.trim() ?? "";
	const hostname = process.env.MCP_HOST?.trim() || "127.0.0.1";
	const authed = (req: Request): boolean => {
		if (!token) return false;
		const auth = req.headers.get("authorization") ?? "";
		const m = auth.match(/^Bearer\s+(.+)$/i);
		return m ? timingSafeStringEqual(m[1].trim(), token) : false;
	};

	const server = startHttpServer({
		port,
		hostname,
		async fetch(req) {
			const url = new URL(req.url);
			if (!url.pathname.endsWith("/mcp")) {
				return Response.json({ error: "not found" }, { status: 404 });
			}
			if (req.method === "GET") {
				return Response.json({ server: SERVER_INFO, tools: TOOLS.length });
			}
			if (req.method !== "POST") {
				return Response.json({ error: "method not allowed" }, { status: 405 });
			}
			if (!authed(req)) {
				return Response.json({ error: "unauthorized" }, { status: 401 });
			}
			let msg: RpcRequest;
			try {
				msg = (await req.json()) as RpcRequest;
			} catch {
				return Response.json(
					{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
					{ status: 400 },
				);
			}
			try {
				const out = await processMessage(msg);
				if (!out) return new Response(null, { status: 202 });
				if (out.error) {
					return Response.json(
						{ jsonrpc: "2.0", id: out.id, error: out.error },
						{ status: 200 },
					);
				}
				return Response.json({ jsonrpc: "2.0", id: out.id, result: out.result });
			} catch (err) {
				return Response.json(
					{
						jsonrpc: "2.0",
						id: (msg as RpcRequest).id ?? null,
						error: {
							code: -32603,
							message: err instanceof Error ? err.message : String(err),
						},
					},
					{ status: 200 },
				);
			}
		},
	});

	console.log(`[uniroute-mcp] HTTP listening on :${server.port}/mcp`);
}

/* ---------------------------------- main ----------------------------------- */

const argv = process.argv.slice(2);
if (argv.includes("--http")) {
	const flagIdx = argv.indexOf("--http");
	const portArg = Number(argv[flagIdx + 1]);
	void runHttp(
		Number.isFinite(portArg) && portArg > 0
			? portArg
			: Number(process.env.UNIROUTE_MCP_PORT ?? 3007),
	);
} else {
	void runStdio();
}

process.on("SIGINT", () => process.exit(0));
