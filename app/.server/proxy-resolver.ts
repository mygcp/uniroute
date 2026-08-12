import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { once } from "node:events";
import type { Socket } from "node:net";
import { query } from "./db";
import { recordProxyLog } from "./logger";
import {
	getGlobalProxyPool,
	getPool,
	getProxy,
	type ProxyConfig,
	type ProxyPool,
} from "./outbound-proxy";

/**
 * Outbound Proxy Engine — single egress point for all upstream HTTP/S traffic.
 *
 * Selection hierarchy (spec 4.1):
 *   1. API key pool  (client_api_keys assigned pool)
 *   2. Provider pool (providers assigned pool)
 *   3. Direct connection (no pool → plain fetch)
 *
 * Within a pool, proxies are picked round-robin by `last_used_at`
 * (same pattern as balancer.ts). Connection errors and retryable HTTP
 * statuses rotate to the next proxy; 401/407 never trigger failover.
 */

export interface ResolvedProxy {
	proxy: ProxyConfig;
	poolId: number;
	poolName: string;
}

export interface FetchUpstreamInit extends RequestInit {
	/** Pool assigned to the client API key (highest priority). */
	apiKeyPoolId?: number;
	/** Pool assigned to the provider (second priority). */
	providerPoolId?: number;
	/** Explicit pool override (skips resolution priority). */
	proxyPoolId?: number;
	/** Provider id, used only for diagnostics. */
	providerId?: string;
	/** Called each time a specific proxy is about to be used. */
	onProxyUsed?: (resolved: ResolvedProxy) => void;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export function resolveProxyPool(params: {
	apiKeyPoolId?: number;
	providerPoolId?: number;
	globalPoolId?: number;
}): ResolvedProxy[] | null {
	let pool: ProxyPool | null = null;
	if (params.apiKeyPoolId) pool = getPool(params.apiKeyPoolId);
	if (!pool && params.providerPoolId) pool = getPool(params.providerPoolId);
	if (!pool && params.globalPoolId) pool = getPool(params.globalPoolId);
	if (!pool || !pool.is_active || pool.proxy_ids.length === 0) return null;

	const active: ResolvedProxy[] = [];
	for (const id of pool.proxy_ids) {
		const proxy = getProxy(id);
		if (proxy && proxy.is_active) {
			active.push({ proxy, poolId: pool.id, poolName: pool.name });
		}
	}
	return active.length > 0 ? active : null;
}

/** Round-robin pick: least recently used proxy first. */
export function pickProxy(chain: ResolvedProxy[]): ResolvedProxy | undefined {
	if (chain.length === 0) return undefined;
	return [...chain].sort(
		(a, b) => a.proxy.last_used_at - b.proxy.last_used_at,
	)[0];
}

function markProxyUsed(id: number): void {
	query(
		"UPDATE outbound_proxies SET last_used_at = ?, updated_at = ? WHERE id = ?",
	).run(Date.now(), Math.floor(Date.now() / 1000), id);
}

// ---------------------------------------------------------------------------
// Single egress point
// ---------------------------------------------------------------------------

export async function fetchUpstream(
	url: string,
	init: FetchUpstreamInit,
): Promise<Response> {
	const {
		apiKeyPoolId,
		providerPoolId,
		proxyPoolId,
		providerId,
		onProxyUsed,
		...fetchInit
	} = init;

	let chain =
		proxyPoolId != null
			? resolveProxyPool({ apiKeyPoolId: proxyPoolId })
			: resolveProxyPool({ apiKeyPoolId, providerPoolId });
	if (!chain) {
		const globalPool = getGlobalProxyPool();
		if (globalPool) chain = resolveProxyPool({ globalPoolId: globalPool.id });
	}

	if (!chain) {
		// No active proxy pool → direct connection (current behavior).
		return fetch(url, fetchInit);
	}

	const ordered = [...chain].sort(
		(a, b) => a.proxy.last_used_at - b.proxy.last_used_at,
	);
	let lastResponse: Response | null = null;
	let lastError: string | null = null;

	for (const resolved of ordered) {
		markProxyUsed(resolved.proxy.id);
		onProxyUsed?.(resolved);
		const started = Date.now();
		try {
			const resp = await proxyFetch(url, fetchInit, resolved.proxy);
			if (resp.status === 401 || resp.status === 407) {
				// Authentication failures never trigger failover.
				return resp;
			}
			if (resp.ok || !RETRYABLE_STATUS.has(resp.status)) {
				return resp;
			}
			lastResponse = resp;
			recordProxyLog({
				level: "warn",
				source: "proxy-resolver",
				message: `retryable status ${resp.status} via proxy ${resolved.proxy.name}`,
				metadata: {
					proxy: `${resolved.proxy.host}:${resolved.proxy.port}`,
					status: resp.status,
					latencyMs: Date.now() - started,
					providerId: providerId ?? null,
				},
			});
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
			recordProxyLog({
				level: "error",
				source: "proxy-resolver",
				message: `proxy connection failed: ${lastError}`,
				metadata: {
					proxy: `${resolved.proxy.host}:${resolved.proxy.port}`,
					poolId: resolved.poolId,
					latencyMs: Date.now() - started,
					providerId: providerId ?? null,
				},
			});
		}
	}

	if (lastResponse) {
		// Pool exhausted but last attempt returned a retryable response.
		return lastResponse;
	}
	return new Response(
		JSON.stringify({
			error: {
				message: lastError ?? "all proxies in pool failed",
				type: "proxy_error",
			},
		}),
		{
			status: 502,
			headers: { "Content-Type": "application/json" },
		},
	);
}

// ---------------------------------------------------------------------------
// Proxy tunneling (HTTP CONNECT / SOCKS5)
// ---------------------------------------------------------------------------

async function connectToProxy(
	proxy: ProxyConfig,
	signal?: AbortSignal,
): Promise<Socket> {
	const socket = netConnect({ host: proxy.host, port: proxy.port });
	let settled = false;
	const onAbort = () => {
		if (!settled) {
			settled = true;
			socket.destroy(new Error("aborted"));
		}
	};
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await once(socket, "connect");
	} catch (err) {
		settled = true;
		throw err instanceof Error && err.message === "aborted"
			? new Error("proxy connect aborted")
			: err;
	}
	return socket;
}

/** Establish an HTTP CONNECT tunnel to `targetHost:targetPort`. */
async function httpConnectTunnel(
	proxy: ProxyConfig,
	targetHost: string,
	targetPort: number,
	signal?: AbortSignal,
): Promise<Socket> {
	const socket = await connectToProxy(proxy, signal);
	const auth =
		proxy.username && proxy.password
			? `Proxy-Authorization: Basic ${Buffer.from(
					`${proxy.username}:${proxy.password}`,
				).toString("base64")}\r\n`
			: "";
	socket.write(
		`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
			`Host: ${targetHost}:${targetPort}\r\n` +
			`${auth}\r\n`,
	);
	const { head } = await readUntil(
		socket,
		Buffer.from("\r\n\r\n"),
		16 * 1024,
		signal,
	);
	const statusLine = head.toString("latin1").split("\r\n")[0] ?? "";
	const code = Number(statusLine.split(" ")[1] ?? 0);
	if (code !== 200) {
		socket.destroy();
		throw new Error(`CONNECT failed: ${statusLine}`);
	}
	return socket;
}

/** Establish a SOCKS5 tunnel (RFC 1928) to `targetHost:targetPort`. */
async function socks5Tunnel(
	proxy: ProxyConfig,
	targetHost: string,
	targetPort: number,
	signal?: AbortSignal,
): Promise<Socket> {
	const socket = await connectToProxy(proxy, signal);
	const hasAuth = Boolean(proxy.username && proxy.password);

	// Greeting: version 5, list of supported methods.
	socket.write(
		hasAuth
			? Buffer.from([0x05, 0x02, 0x00, 0x02])
			: Buffer.from([0x05, 0x01, 0x00]),
	);
	const methodResp = await readN(socket, 2, signal);
	if (methodResp[0] !== 0x05) throw new Error("socks5: bad greeting response");
	const method = methodResp[1];
	if (method === 0xff) throw new Error("socks5: no acceptable auth method");
	if (method === 0x02) {
		const user = Buffer.from(proxy.username ?? "", "utf8");
		const pass = Buffer.from(proxy.password ?? "", "utf8");
		if (user.length > 255 || pass.length > 255)
			throw new Error("socks5: credentials too long");
		socket.write(
			Buffer.concat([
				Buffer.from([0x01, user.length]),
				user,
				Buffer.from([pass.length]),
				pass,
			]),
		);
		const authResp = await readN(socket, 2, signal);
		if (authResp[0] !== 0x01 || authResp[1] !== 0x00) {
			throw new Error("socks5: authentication failed");
		}
	}

	const hostBuf = Buffer.from(targetHost, "utf8");
	if (hostBuf.length > 255) throw new Error("socks5: host too long");
	// CONNECT request: VER=5 CMD=1 RSV=0 ATYP=3(domain) LEN host PORT.
	socket.write(
		Buffer.concat([
			Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
			hostBuf,
			Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
		]),
	);
	const resp = await readN(socket, 4, signal);
	if (resp[0] !== 0x05 || resp[1] !== 0x00) {
		socket.destroy();
		throw new Error(`socks5: connect failed (reply ${resp[1]})`);
	}
	const atyp = resp[3];
	let addrLen = 0;
	if (atyp === 0x01)
		addrLen = 4; // IPv4
	else if (atyp === 0x03)
		addrLen = (await readN(socket, 1, signal))[0]; // domain
	else if (atyp === 0x04)
		addrLen = 16; // IPv6
	else throw new Error("socks5: bad address type");
	await readN(socket, addrLen + 2, signal);
	return socket;
}

// ---------------------------------------------------------------------------
// Raw HTTP/1.1 request over a tunneled socket
// ---------------------------------------------------------------------------

async function proxyFetch(
	url: string,
	init: RequestInit,
	proxy: ProxyConfig,
): Promise<Response> {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		throw new Error(`invalid upstream url: ${url}`);
	}
	const isHttps = target.protocol === "https:";
	const targetPort = Number(target.port) || (isHttps ? 443 : 80);

	const raw = await (proxy.type === "socks5"
		? socks5Tunnel(proxy, target.hostname, targetPort, init.signal ?? undefined)
		: httpConnectTunnel(
				proxy,
				target.hostname,
				targetPort,
				init.signal ?? undefined,
			));

	let socket: Socket = raw;
	if (isHttps) {
		const tls = tlsConnect({ socket: raw, servername: target.hostname });
		const onAbort = () => tls.destroy(new Error("aborted"));
		if (init.signal?.aborted) onAbort();
		else init.signal?.addEventListener("abort", onAbort, { once: true });
		await once(tls, "secureConnect");
		socket = tls;
	}

	const method = init.method ?? "GET";
	const body = typeof init.body === "string" ? init.body : undefined;
	const headers = new Headers(init.headers);
	headers.set("Host", target.host);
	headers.set("Connection", "close");
	if (body) headers.set("Content-Length", String(Buffer.byteLength(body)));

	const requestHead =
		`${method} ${target.pathname}${target.search} HTTP/1.1\r\n` +
		[...headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\r\n") +
		"\r\n\r\n";
	socket.write(requestHead + (body ?? ""));

	const { status, tail, respHeaders } = await readResponseHead(
		socket,
		init.signal ?? undefined,
	);
	const bodyStream = makeBodyStream(
		socket,
		tail,
		respHeaders,
		init.signal ?? undefined,
	);
	return new Response(bodyStream, { status, headers: respHeaders });
}
function readResponseHead(
	socket: Socket,
	signal?: AbortSignal,
): Promise<{ status: number; head: Buffer; tail: Buffer; respHeaders: Headers }> {
	return readUntil(socket, Buffer.from("\r\n\r\n"), 64 * 1024, signal).then(
		({ head, tail }) => {
			const text = head.toString("latin1");
			const lines = text.split("\r\n");
			const statusLine = lines[0] ?? "";
			const status = Number(statusLine.split(" ")[1] ?? 0);
			const respHeaders = new Headers();
			for (let i = 1; i < lines.length; i++) {
				const line = lines[i];
				const idx = line.indexOf(":");
				if (idx <= 0) continue;
				const name = line.slice(0, idx).trim();
				const value = line.slice(idx + 1).trim();
				respHeaders.append(name, value);
			}
			return { status, head, tail, respHeaders };
		},
	);
}

// ---------------------------------------------------------------------------
// Socket reading helpers
// ---------------------------------------------------------------------------

function readN(
	socket: Socket,
	n: number,
	signal?: AbortSignal,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		let buf = Buffer.alloc(0);
		let done = false;
		const onData = (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			if (buf.length >= n) {
				cleanup();
				done = true;
				resolve(buf.subarray(0, n));
			}
		};
		const onError = (err: Error) => {
			if (done) return;
			cleanup();
			done = true;
			reject(err);
		};
		const onEnd = () => {
			if (done) return;
			cleanup();
			done = true;
			reject(new Error("socket closed while reading"));
		};
		const onAbort = () => {
			if (done) return;
			cleanup();
			done = true;
			reject(new Error("aborted"));
		};
		const cleanup = () => {
			socket.off("data", onData);
			socket.off("error", onError);
			socket.off("end", onEnd);
			socket.off("close", onEnd);
			signal?.removeEventListener("abort", onAbort);
		};
		socket.on("data", onData);
		socket.on("error", onError);
		socket.on("end", onEnd);
		socket.on("close", onEnd);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}
function readUntil(
	socket: Socket,
	delimiter: Buffer,
	maxSize: number,
	signal?: AbortSignal,
): Promise<{ head: Buffer; tail: Buffer }> {
	return new Promise((resolve, reject) => {
		let buf = Buffer.alloc(0);
		let done = false;
		const onData = (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			if (buf.length > maxSize) {
				cleanup();
				done = true;
				reject(new Error("response head too large"));
				return;
			}
			const idx = buf.indexOf(delimiter);
			if (idx !== -1) {
				cleanup();
				done = true;
				resolve({
					head: buf.subarray(0, idx),
					tail: buf.subarray(idx + delimiter.length),
				});
			}
		};
		const onError = (err: Error) => {
			if (done) return;
			cleanup();
			done = true;
			reject(err);
		};
		const onEnd = () => {
			if (done) return;
			cleanup();
			done = true;
			reject(new Error("socket closed before response head"));
		};
		const onAbort = () => {
			if (done) return;
			cleanup();
			done = true;
			reject(new Error("aborted"));
		};
		const cleanup = () => {
			socket.off("data", onData);
			socket.off("error", onError);
			socket.off("end", onEnd);
			socket.off("close", onEnd);
			signal?.removeEventListener("abort", onAbort);
		};
		socket.on("data", onData);
		socket.on("error", onError);
		socket.on("end", onEnd);
		socket.on("close", onEnd);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// ---------------------------------------------------------------------------
// Response body stream (Content-Length / chunked / close-delimited)
// ---------------------------------------------------------------------------
function makeBodyStream(
	socket: Socket,
	initial: Buffer,
	headers: Headers,
	signal?: AbortSignal,
): ReadableStream<Uint8Array> {
	const transferEncoding = (
		headers.get("transfer-encoding") ?? ""
	).toLowerCase();
	const chunked = transferEncoding.includes("chunked");
	const contentLength = headers.has("content-length")
		? Number(headers.get("content-length"))
		: null;

	return new ReadableStream<Uint8Array>({
		start(controller) {
			let emitted = 0;
			let done = false;
			// Chunked parser state.
			let chunkMode: "size" | "data" | "trailer" = chunked ? "size" : "trailer";
			let chunkRemaining = 0;
			let chunkTerm = 0; // CRLF terminator bytes still to skip after a chunk
			let lineBuf = Buffer.alloc(0);
			let trailerBuf = Buffer.alloc(0);

			const finish = () => {
				if (done) return;
				done = true;
				controller.close();
			};
			const fail = (err: unknown) => {
				if (done) return;
				done = true;
				controller.error(err);
			};
			const onAbort = () => {
				fail(new Error("aborted"));
				socket.destroy();
			};
			const cleanup = () => {
				socket.off("data", onData);
				socket.off("end", onEnd);
				socket.off("close", onClose);
				socket.off("error", onError);
				signal?.removeEventListener("abort", onAbort);
			};

			const consume = (data: Buffer): boolean => {
				// Returns false when the stream is finished (stop processing).
				let pos = 0;
				while (pos < data.length) {
					if (chunked && chunkMode === "size") {
						// Skip the CRLF that terminates the previous chunk's data.
						if (chunkTerm > 0) {
							const take = Math.min(chunkTerm, data.length - pos);
							pos += take;
							chunkTerm -= take;
							if (chunkTerm > 0) return true;
						}
						const nl = data.indexOf(Buffer.from("\r\n"), pos);
						if (nl === -1) {
							lineBuf = Buffer.concat([lineBuf, data.subarray(pos)]);
							return true; // wait for more
						}
						const line = Buffer.concat([
							lineBuf,
							data.subarray(pos, nl),
						]).toString("latin1");
						lineBuf = Buffer.alloc(0);
						pos = nl + 2;
						const size = parseInt(line.split(";")[0].trim(), 16);
						if (Number.isNaN(size)) {
							fail(new Error("invalid chunk size"));
							return false;
						}
						chunkRemaining = size;
						chunkMode = size === 0 ? "trailer" : "data";
						continue;
					}
					if (chunked && chunkMode === "data") {
						const take = Math.min(chunkRemaining, data.length - pos);
						if (take > 0) {
							controller.enqueue(new Uint8Array(data.subarray(pos, pos + take)));
							pos += take;
							chunkRemaining -= take;
						}
						if (chunkRemaining === 0) {
							chunkMode = "size";
							chunkTerm = 2;
						}
						continue;
					}
					if (chunked && chunkMode === "trailer") {
						trailerBuf = Buffer.concat([trailerBuf, data.subarray(pos)]);
						const hasBlankLine =
							trailerBuf.length >= 2 &&
							trailerBuf.subarray(0, 2).equals(Buffer.from("\r\n"));
						if (hasBlankLine || trailerBuf.indexOf(Buffer.from("\r\n\r\n")) !== -1) {
							finish();
							return false;
						}
						return true;
					}
					// Non-chunked: content-length or close-delimited.
					if (contentLength != null) {
						const remaining = contentLength - emitted;
						const take = Math.min(remaining, data.length - pos);
						if (take > 0) {
							controller.enqueue(new Uint8Array(data.subarray(pos, pos + take)));
							pos += take;
							emitted += take;
						}
						if (emitted >= contentLength) {
							finish();
							return false;
						}
						if (pos >= data.length) return true;
						continue;
					}
					// Close-delimited: emit everything until the socket ends.
					controller.enqueue(new Uint8Array(data.subarray(pos)));
					return true;
				}
				return true;
			};

			const onData = (data: Buffer) => {
				if (done) return;
				try {
					if (!consume(data)) cleanup();
				} catch (err) {
					fail(err);
					cleanup();
				}
			};
			const onEnd = () => {
				if (done) return;
				if (contentLength != null && emitted < contentLength) {
					fail(new Error("connection closed before body complete"));
				} else if (chunked && (chunkMode === "data" || chunkRemaining > 0)) {
					fail(new Error("connection closed mid-chunk"));
				} else {
					finish();
				}
			};
			const onClose = () => {
				if (done) return;
				if (contentLength != null && emitted < contentLength) {
					fail(new Error("connection closed before body complete"));
				} else {
					finish();
				}
			};
			const onError = (err: Error) => {
				fail(err);
			};

			socket.on("data", onData);
			socket.on("end", onEnd);
			socket.on("close", onClose);
			socket.on("error", onError);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });

			// Process bytes that arrived together with the response head.
			if (initial.length > 0 && !done) {
				try {
					if (!consume(initial)) cleanup();
				} catch (err) {
					fail(err);
					cleanup();
				}
			}
		},
		cancel() {
			socket.destroy();
		},
	});
}

// ---------------------------------------------------------------------------
// Connection testing
// ---------------------------------------------------------------------------

export interface ProxyTestResult {
	ok: boolean;
	latencyMs: number;
	status: number | null;
}

export async function testProxyConnection(
	proxy: ProxyConfig,
	testUrl = "https://api.openai.com/v1/models",
): Promise<ProxyTestResult> {
	const started = Date.now();
	try {
		const resp = await proxyFetch(
			testUrl,
			{ method: "GET", headers: { accept: "*/*" } },
			proxy,
		);
		// Reading the body fully also validates the tunnel for streaming.
		await resp.arrayBuffer().catch(() => undefined);
		return { ok: true, latencyMs: Date.now() - started, status: resp.status };
	} catch (err) {
		recordProxyLog({
			level: "error",
			source: "proxy-resolver",
			message: `proxy test failed: ${err instanceof Error ? err.message : String(err)}`,
			metadata: { proxy: `${proxy.host}:${proxy.port}`, testUrl },
		});
		return { ok: false, latencyMs: Date.now() - started, status: null };
	}
}
