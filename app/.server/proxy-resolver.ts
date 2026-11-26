import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { once } from "node:events";
import type { Socket } from "node:net";
import { onDbReset } from "./db";
import { recordProxyLog } from "./logger";
import {
	getGlobalProxyPool,
	getPool,
	getProxy,
	hasAnyProxyPools,
	type PoolStrategy,
	type ProxyConfig,
	type ProxyPool,
	recordProxyResult,
} from "./outbound-proxy";
import { validateUrlSync } from "./ssrf";

/**
 * Outbound Proxy Engine — single egress point for all upstream HTTP/S traffic.
 *
 * Selection hierarchy (spec 4.1):
 *   1. API key pool         (client_api_keys assigned pool)
 *   2. Provider API key pool (provider_credentials.proxy_pool_id)
 *   3. Combo pool            (combo config proxy_pool_id)
 *   4. Provider pool         (providers assigned pool)
 *   5. Global pool           (getGlobalProxyPool)
 *   6. Direct connection     (no pool → plain fetch)
 *
 * Precedence: client key → account → combo → provider → global → direct.
 *
 * Within a pool, proxies are picked round-robin by `last_used_at`
 * (same pattern as balancer.ts). Connection errors and retryable HTTP
 * statuses rotate to the next proxy; 401/407 never trigger failover.
 */

export interface ResolvedProxy {
	proxy: ProxyConfig;
	poolId: number;
	poolName: string;
	strategy: PoolStrategy;
}

export interface FetchUpstreamInit extends RequestInit {
	/** Pool assigned to the client API key (highest priority). */
	apiKeyPoolId?: number;
	/** Pool assigned to the provider credential (second priority). */
	accountPoolId?: number;
	/** Pool assigned to the combo (third priority). */
	comboPoolId?: number;
	/** Pool assigned to the provider (fourth priority). */
	providerPoolId?: number;
	/** Explicit pool override (skips resolution priority). */
	proxyPoolId?: number;
	/** Provider id, used only for diagnostics. */
	providerId?: string;
	/** Konteks untuk proxy_logs: ip client & api key client (opsional). */
	logClientIp?: string | null;
	logApiKeyId?: number | null;
	/** Called each time a specific proxy is about to be used. */
	onProxyUsed?: (resolved: ResolvedProxy) => void;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Batas waktu pembentukan tunnel (TCP + CONNECT/SOCKS handshake). */
const PROXY_CONNECT_TIMEOUT_MS = 8_000;
/** Proxy dengan latensi terakhir di atas nilai ini didemosi ke ekor chain. */
const SLOW_PROXY_MS = 5_000;

// Konstanta byte dipakai di loop parsing panas — hindari alokasi per chunk.
const CRLF = Buffer.from("\r\n");
const CRLF_CRLF = Buffer.from("\r\n\r\n");

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export function resolveProxyPool(params: {
	apiKeyPoolId?: number;
	accountPoolId?: number;
	providerPoolId?: number;
	comboPoolId?: number;
	globalPoolId?: number;
}): ResolvedProxy[] | null {
	let pool: ProxyPool | null = null;
	if (params.apiKeyPoolId) pool = getPool(params.apiKeyPoolId);
	if (!pool && params.accountPoolId) pool = getPool(params.accountPoolId);
	if (!pool && params.comboPoolId) pool = getPool(params.comboPoolId);
	if (!pool && params.providerPoolId) pool = getPool(params.providerPoolId);
	if (!pool && params.globalPoolId) pool = getPool(params.globalPoolId);
	if (!pool || !pool.is_active || pool.proxy_ids.length === 0) return null;

	const active: ResolvedProxy[] = [];
	for (const id of pool.proxy_ids) {
		const proxy = getProxy(id);
		if (proxy && proxy.is_active) {
			active.push({
				proxy,
				poolId: pool.id,
				poolName: pool.name,
				strategy: pool.strategy,
			});
		}
	}
	return active.length > 0 ? active : null;
}

/**
 * Urutan pemakaian proxy sesuai strategy pool:
 * - round_robin: least-recently-used dulu (rotasi merata)
 * - priority   : urutan sesuai daftar di pool (index pertama = utama)
 * - random     : acak tiap request
 */
export function orderProxiesByStrategy(
	chain: ResolvedProxy[],
): ResolvedProxy[] {
	if (chain.length <= 1) return chain;
	const strategy = chain[0].strategy;
	let ordered: ResolvedProxy[];
	switch (strategy) {
		case "priority":
			ordered = [...chain];
			break;
		case "random": {
			ordered = [...chain];
			for (let i = ordered.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!];
			}
			break;
		}
		case "round_robin":
		default:
			ordered = [...chain].sort(
				(a, b) => a.proxy.last_used_at - b.proxy.last_used_at,
			);
			break;
	}
	// Demosi proxy lambat ke ekor chain — strategi tetap berlaku di antara
	// proxy yang sehat. Mencegah request jatuh ke proxy yang butuh puluhan
	// detik padahal ada yang responsif.
	const isSlow = (r: ResolvedProxy) =>
		r.proxy.last_latency_ms != null && r.proxy.last_latency_ms > SLOW_PROXY_MS;
	return [
		...ordered.filter((r) => !isSlow(r)),
		...ordered.filter(isSlow),
	];
}

function markProxyUsed(resolved: ResolvedProxy): void {
	resolved.proxy.last_used_at = Date.now();
}

export async function fetchUpstream(
	url: string,
	init: FetchUpstreamInit,
): Promise<Response> {
	const urlCheck = validateUrlSync(url, { allowPrivate: true, allowLoopback: true });
	if (!urlCheck.ok) {
		throw new Error(`blocked upstream url: ${urlCheck.reason}`);
	}

	const {
		apiKeyPoolId,
		accountPoolId,
		providerPoolId,
		comboPoolId,
		proxyPoolId,
		providerId,
		onProxyUsed,
		logClientIp,
		logApiKeyId,
		...fetchInit
	} = init;

	let chain: ResolvedProxy[] | null = null;
	if (hasAnyProxyPools()) {
		chain =
			proxyPoolId != null
				? resolveProxyPool({ apiKeyPoolId: proxyPoolId })
				: resolveProxyPool({ apiKeyPoolId, accountPoolId, providerPoolId, comboPoolId });
		if (!chain) {
			const globalPool = getGlobalProxyPool();
			if (globalPool) chain = resolveProxyPool({ globalPoolId: globalPool.id });
		}
	}

	if (!chain) {
		return fetch(url, fetchInit);
	}

	const ordered = orderProxiesByStrategy(chain);
	let lastResponse: Response | null = null;
	let lastError: string | null = null;

	for (const resolved of ordered) {
		markProxyUsed(resolved);
		onProxyUsed?.(resolved);
		const started = Date.now();
		try {
			const resp = await proxyFetch(url, fetchInit, resolved.proxy);
			if (resp.status === 401 || resp.status === 407) {
				// Authentication failures never trigger failover.
				recordProxyResult(resolved.proxy.id, {
					ok: false,
					latencyMs: Date.now() - started,
					error: `auth failed (HTTP ${resp.status})`,
				});
				return resp;
			}
			if (resp.ok || !RETRYABLE_STATUS.has(resp.status)) {
				recordProxyResult(resolved.proxy.id, {
					ok: true,
					latencyMs: Date.now() - started,
				});
				return resp;
			}
			lastResponse = resp;
			recordProxyResult(resolved.proxy.id, {
				ok: false,
				latencyMs: Date.now() - started,
				error: `retryable status ${resp.status}`,
			});
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
				provider_id: providerId ?? null,
				proxy_id: resolved.proxy.id,
				latency_ms: Date.now() - started,
				client_ip: logClientIp ?? null,
				api_key_id: logApiKeyId ?? null,
			});
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
			recordProxyResult(resolved.proxy.id, {
				ok: false,
				latencyMs: Date.now() - started,
				error: lastError ?? "connection failed",
			});
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
				provider_id: providerId ?? null,
				proxy_id: resolved.proxy.id,
				latency_ms: Date.now() - started,
				client_ip: logClientIp ?? null,
				api_key_id: logApiKeyId ?? null,
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

/**
 * Bentukkan tunnel dengan batas waktu ketat: TCP connect + handshake harus
 * selesai dalam PROXY_CONNECT_TIMEOUT_MS, kalau tidak socket dihancurkan dan
 * error dilempar → resolver failover ke proxy berikutnya. Tanpa ini, proxy
 * mati/ lambat bisa menggantung request puluhan detik.
 */
async function establishTunnel(
	proxy: ProxyConfig,
	targetHost: string,
	targetPort: number,
	outerSignal?: AbortSignal,
): Promise<Socket> {
	const ctrl = new AbortController();
	const onOuter = () => ctrl.abort();
	outerSignal?.addEventListener("abort", onOuter, { once: true });
	const timer = setTimeout(() => ctrl.abort(), PROXY_CONNECT_TIMEOUT_MS);
	try {
		return await (proxy.type === "socks5"
			? socks5Tunnel(proxy, targetHost, targetPort, ctrl.signal)
			: httpConnectTunnel(proxy, targetHost, targetPort, ctrl.signal));
	} catch (err) {
		// Abort dari timer internal kita = timeout koneksi, bukan pembatalan client.
		if (
			err instanceof Error &&
			err.message === "aborted" &&
			!outerSignal?.aborted
		) {
			throw new Error(
				`proxy connect timeout (${PROXY_CONNECT_TIMEOUT_MS}ms)`,
			);
		}
		throw err;
	} finally {
		clearTimeout(timer);
		outerSignal?.removeEventListener("abort", onOuter);
	}
}

async function connectToProxy(
	proxy: ProxyConfig,
	signal?: AbortSignal,
): Promise<Socket> {
	const socket = netConnect({ host: proxy.host, port: proxy.port });
	// Tanpa ini, destroy(err) pada jalur abort/timeout bisa memancarkan
	// event 'error' tanpa listener dan menjatuhkan proses.
	socket.on("error", () => {});
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
	const { head } = await readUntil(socket, CRLF_CRLF, 16 * 1024, signal);
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

type PooledSocket = {
	socket: Socket;
	key: string;
	expiresAt: number;
	cleanup: () => void;
};

const MAX_IDLE_SOCKETS = 64;
const IDLE_SOCKET_TTL_MS = 15_000;
const MAX_CHUNK_LINE_BYTES = 8 * 1024;
const MAX_CHUNK_TRAILER_BYTES = 16 * 1024;
const idleSocketPool = new Map<string, PooledSocket[]>();
let totalIdleSockets = 0;

function removePooledEntry(entry: PooledSocket): void {
	const list = idleSocketPool.get(entry.key);
	if (!list) return;
	const idx = list.indexOf(entry);
	if (idx !== -1) {
		list.splice(idx, 1);
		totalIdleSockets = Math.max(0, totalIdleSockets - 1);
		if (list.length === 0) idleSocketPool.delete(entry.key);
	}
	entry.cleanup();
}

function takePooledSocket(key: string): Socket | null {
	const list = idleSocketPool.get(key);
	if (!list || list.length === 0) return null;
	const now = Date.now();
	while (list.length > 0) {
		const entry = list.pop()!;
		totalIdleSockets = Math.max(0, totalIdleSockets - 1);
		entry.cleanup();
		if (list.length === 0) idleSocketPool.delete(key);
		if (
			entry.expiresAt > now &&
			!entry.socket.destroyed &&
			entry.socket.writable &&
			entry.socket.readable
		) {
			entry.socket.ref?.();
			return entry.socket;
		}
		entry.socket.destroy();
	}
	idleSocketPool.delete(key);
	return null;
}

function evictOldestIdleSocket(): void {
	for (const [, list] of idleSocketPool) {
		if (list.length > 0) {
			const oldest = list[0]!;
			removePooledEntry(oldest);
			oldest.socket.destroy();
			return;
		}
	}
}

function returnPooledSocket(key: string, socket: Socket): void {
	if (socket.destroyed || !socket.writable || !socket.readable) {
		socket.destroy();
		return;
	}
	while (totalIdleSockets >= MAX_IDLE_SOCKETS) {
		evictOldestIdleSocket();
	}
	const onGone = () => {
		removePooledEntry(entry);
		socket.destroy();
	};
	const entry: PooledSocket = {
		socket,
		key,
		expiresAt: Date.now() + IDLE_SOCKET_TTL_MS,
		cleanup: () => {
			socket.off("close", onGone);
			socket.off("end", onGone);
			socket.off("error", onGone);
		},
	};
	socket.on("close", onGone);
	socket.on("end", onGone);
	socket.on("error", onGone);
	socket.unref?.();

	let list = idleSocketPool.get(key);
	if (!list) {
		list = [];
		idleSocketPool.set(key, list);
	}
	list.push(entry);
	totalIdleSockets += 1;
}

export function closeIdleProxySockets(): void {
	for (const [, list] of idleSocketPool) {
		for (const entry of list) {
			entry.cleanup();
			entry.socket.destroy();
		}
	}
	idleSocketPool.clear();
	totalIdleSockets = 0;
}

onDbReset(closeIdleProxySockets);

async function openUpstreamSocket(
	proxy: ProxyConfig,
	hostname: string,
	port: number,
	isHttps: boolean,
	signal?: AbortSignal,
): Promise<Socket> {
	const raw = await establishTunnel(proxy, hostname, port, signal);
	if (!isHttps) return raw;

	const tls = tlsConnect({ socket: raw, servername: hostname });
	tls.on("error", () => {});
	const onAbort = () => tls.destroy(new Error("aborted"));
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), PROXY_CONNECT_TIMEOUT_MS);
	const onSignalAbort = () => ctrl.abort();
	signal?.addEventListener("abort", onSignalAbort, { once: true });
	try {
		if (signal?.aborted || ctrl.signal.aborted) onAbort();
		else ctrl.signal.addEventListener("abort", onAbort, { once: true });
		await once(tls, "secureConnect");
	} catch (err) {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onSignalAbort);
		if (ctrl.signal.aborted && !signal?.aborted) {
			tls.destroy();
			throw new Error(
				`proxy TLS handshake timeout (${PROXY_CONNECT_TIMEOUT_MS}ms)`,
			);
		}
		throw err;
	}
	clearTimeout(timer);
	signal?.removeEventListener("abort", onSignalAbort);
	return tls;
}

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
	const poolKey = `${proxy.id}|${target.hostname}|${targetPort}|${isHttps ? 1 : 0}`;
	const signal = init.signal ?? undefined;

	const method = init.method ?? "GET";
	const body = typeof init.body === "string" ? init.body : undefined;
	const headers = new Headers(init.headers);
	headers.set("Host", target.host);
	const callerWantsClose =
		(headers.get("connection") ?? "").toLowerCase() === "close";
	if (!callerWantsClose) {
		headers.set("Connection", "keep-alive");
	}
	if (body) headers.set("Content-Length", String(Buffer.byteLength(body)));

	const requestHead =
		`${method} ${target.pathname}${target.search} HTTP/1.1\r\n` +
		[...headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\r\n") +
		"\r\n\r\n";

	let socket = takePooledSocket(poolKey);
	let reused = socket !== null;
	if (!socket) {
		socket = await openUpstreamSocket(proxy, target.hostname, targetPort, isHttps, signal);
	}

	let parsedHead: { status: number; head: Buffer; tail: Buffer; respHeaders: Headers };
	try {
		socket.write(requestHead + (body ?? ""));
		parsedHead = await readResponseHead(socket, signal);
	} catch (err) {
		socket.destroy();
		if (!reused || signal?.aborted) throw err;
		socket = await openUpstreamSocket(proxy, target.hostname, targetPort, isHttps, signal);
		socket.write(requestHead + (body ?? ""));
		parsedHead = await readResponseHead(socket, signal);
	}

	const { status, tail, respHeaders } = parsedHead;
	const serverWantsClose = (respHeaders.get("connection") ?? "")
		.toLowerCase()
		.includes("close");
	const canKeepAlive = !callerWantsClose && !serverWantsClose;
	const bodyStream = makeBodyStream(
		socket,
		tail,
		respHeaders,
		signal,
		canKeepAlive ? (s) => returnPooledSocket(poolKey, s) : undefined,
	);
	return new Response(bodyStream, { status, headers: respHeaders });
}
function readResponseHead(
	socket: Socket,
	signal?: AbortSignal,
): Promise<{ status: number; head: Buffer; tail: Buffer; respHeaders: Headers }> {
	return readUntil(socket, CRLF_CRLF, 64 * 1024, signal).then(
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

type StepResult<T> = { done: true; value: T } | { done: false };

/**
 * Kumpulkan byte dari socket sampai `step` mengembalikan nilai final.
 * - step mengembalikan `{ done: false }` bila butuh data lagi.
 * - throw di dalam step (mis. limit terlampaui) menolak promise.
 * - abort / socket end-close selesai sebelum nilai final → reject.
 */
function collectSocket<T>(
	socket: Socket,
	signal: AbortSignal | undefined,
	endFailure: () => Error,
	step: (chunk: Buffer) => StepResult<T>,
): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		function cleanup(): void {
			socket.off("data", onData);
			socket.off("error", onError);
			socket.off("end", onEnd);
			socket.off("close", onEnd);
			signal?.removeEventListener("abort", onAbort);
		}
		function settle(fn: () => void): void {
			if (settled) return;
			settled = true;
			cleanup();
			fn();
		}
		function onData(chunk: Buffer): void {
			if (settled) return;
			try {
				const r = step(chunk);
				if (r.done) settle(() => resolve(r.value));
			} catch (err) {
				settle(() =>
					reject(err instanceof Error ? err : new Error(String(err))),
				);
			}
		}
		function onError(err: Error): void {
			settle(() => reject(err));
		}
		function onEnd(): void {
			settle(() => reject(endFailure()));
		}
		const onAbort = () => settle(() => reject(new Error("aborted")));

		socket.on("data", onData);
		socket.on("error", onError);
		socket.on("end", onEnd);
		socket.on("close", onEnd);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Baca tepat `n` byte dari socket. */
function readN(
	socket: Socket,
	n: number,
	signal?: AbortSignal,
): Promise<Buffer> {
	let buf = Buffer.alloc(0);
	return collectSocket<Buffer>(
		socket,
		signal,
		() => new Error("socket closed while reading"),
		(chunk) => {
			buf = Buffer.concat([buf, chunk]);
			if (buf.length >= n) {
				return { done: true, value: buf.subarray(0, n) };
			}
			return { done: false };
		},
	);
}

/** Baca sampai delimiter ditemukan; sisanya dikembalikan sebagai `tail`. */
function readUntil(
	socket: Socket,
	delimiter: Buffer,
	maxSize: number,
	signal?: AbortSignal,
): Promise<{ head: Buffer; tail: Buffer }> {
	let buf = Buffer.alloc(0);
	return collectSocket<{ head: Buffer; tail: Buffer }>(
		socket,
		signal,
		() => new Error("socket closed before response head"),
		(chunk) => {
			buf = Buffer.concat([buf, chunk]);
			if (buf.length > maxSize) {
				throw new Error("response head too large");
			}
			const idx = buf.indexOf(delimiter);
			if (idx === -1) return { done: false };
			return {
				done: true,
				value: {
					head: buf.subarray(0, idx),
					tail: buf.subarray(idx + delimiter.length),
				},
			};
		},
	);
}

// ---------------------------------------------------------------------------
// Response body stream (Content-Length / chunked / close-delimited)
// ---------------------------------------------------------------------------
function makeBodyStream(
	socket: Socket,
	initial: Buffer,
	headers: Headers,
	signal?: AbortSignal,
	onReusableEnd?: (socket: Socket) => void,
): ReadableStream<Uint8Array> {
	const transferEncoding = (
		headers.get("transfer-encoding") ?? ""
	).toLowerCase();
	const chunked = transferEncoding.includes("chunked");
	const contentLength = headers.has("content-length")
		? Number(headers.get("content-length"))
		: null;
	const hasFramedEnd = chunked || (contentLength != null && Number.isFinite(contentLength));

	return new ReadableStream<Uint8Array>({
		start(controller) {
			let emitted = 0;
			let done = false;
			let chunkMode: "size" | "data" | "trailer" = chunked ? "size" : "trailer";
			let chunkRemaining = 0;
			let chunkTerm = 0;
			let lineBuf = Buffer.alloc(0);
			let trailerBuf = Buffer.alloc(0);

			const cleanup = () => {
				socket.off("data", onData);
				socket.off("end", onEnd);
				socket.off("close", onClose);
				socket.off("error", onError);
				signal?.removeEventListener("abort", onAbort);
			};

			const finish = (reusable: boolean) => {
				if (done) return;
				done = true;
				cleanup();
				controller.close();
				if (reusable && hasFramedEnd && onReusableEnd) {
					onReusableEnd(socket);
				} else {
					socket.destroy();
				}
			};
			const fail = (err: unknown) => {
				if (done) return;
				done = true;
				cleanup();
				controller.error(err);
				socket.destroy();
			};
			const onAbort = () => {
				fail(new Error("aborted"));
			};

			const enqueue = (chunk: Uint8Array) => {
				controller.enqueue(chunk);
				if (controller.desiredSize !== null && controller.desiredSize <= 0) {
					socket.pause();
				}
			};

			const consume = (data: Buffer): boolean => {
				let pos = 0;
				while (pos < data.length) {
					if (chunked && chunkMode === "size") {
						if (chunkTerm > 0) {
							const take = Math.min(chunkTerm, data.length - pos);
							pos += take;
							chunkTerm -= take;
							if (chunkTerm > 0) return true;
						}
						const nl = data.indexOf(CRLF, pos);
						if (nl === -1) {
							lineBuf = Buffer.concat([lineBuf, data.subarray(pos)]);
							if (lineBuf.length > MAX_CHUNK_LINE_BYTES) {
								fail(new Error("chunk header line too large"));
								return false;
							}
							return true;
						}
						const line = Buffer.concat([
							lineBuf,
							data.subarray(pos, nl),
						]).toString("latin1");
						lineBuf = Buffer.alloc(0);
						pos = nl + 2;
						const hexPart = line.split(";")[0].trim();
						const size = /^[0-9a-fA-F]+$/.test(hexPart)
							? parseInt(hexPart, 16)
							: Number.NaN;
						if (!Number.isSafeInteger(size) || size < 0) {
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
							enqueue(new Uint8Array(data.subarray(pos, pos + take)));
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
						if (trailerBuf.length > MAX_CHUNK_TRAILER_BYTES) {
							fail(new Error("chunk trailers too large"));
							return false;
						}
						const hasBlankLine =
							trailerBuf.length >= 2 &&
							trailerBuf.subarray(0, 2).equals(CRLF);
						if (hasBlankLine || trailerBuf.indexOf(CRLF_CRLF) !== -1) {
							finish(true);
							return false;
						}
						return true;
					}
					if (contentLength != null) {
						const remaining = contentLength - emitted;
						const take = Math.min(remaining, data.length - pos);
						if (take > 0) {
							enqueue(new Uint8Array(data.subarray(pos, pos + take)));
							pos += take;
							emitted += take;
						}
						if (emitted >= contentLength) {
							finish(true);
							return false;
						}
						if (pos >= data.length) return true;
						continue;
					}
					enqueue(new Uint8Array(data.subarray(pos)));
					return true;
				}
				return true;
			};

			const onData = (data: Buffer) => {
				if (done) return;
				try {
					consume(data);
				} catch (err) {
					fail(err);
				}
			};
			const onEnd = () => {
				if (done) return;
				if (contentLength != null && emitted < contentLength) {
					fail(new Error("connection closed before body complete"));
				} else if (chunked && (chunkMode === "data" || chunkRemaining > 0)) {
					fail(new Error("connection closed mid-chunk"));
				} else {
					finish(false);
				}
			};
			const onClose = () => {
				if (done) return;
				if (contentLength != null && emitted < contentLength) {
					fail(new Error("connection closed before body complete"));
				} else {
					finish(false);
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

			if (initial.length > 0 && !done) {
				try {
					consume(initial);
				} catch (err) {
					fail(err);
				}
			}
		},
		pull() {
			if (!socket.destroyed) socket.resume();
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
		if (proxy.id > 0) {
			recordProxyResult(proxy.id, {
				ok: true,
				latencyMs: Date.now() - started,
			});
		}
		return { ok: true, latencyMs: Date.now() - started, status: resp.status };
	} catch (err) {
		recordProxyLog({
			level: "error",
			source: "proxy-resolver",
			message: `proxy test failed: ${err instanceof Error ? err.message : String(err)}`,
			metadata: { proxy: `${proxy.host}:${proxy.port}`, testUrl },
		});
		if (proxy.id > 0) {
			recordProxyResult(proxy.id, {
				ok: false,
				latencyMs: Date.now() - started,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return { ok: false, latencyMs: Date.now() - started, status: null };
	}
}
