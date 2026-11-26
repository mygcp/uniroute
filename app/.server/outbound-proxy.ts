import { exec, getTableVersion, onBeforeRead, onDbReset, onShutdownFlush, query } from "./db";
import { encryptKey, decryptKey, hasApiKeySecret } from "./key-crypto";
import { getCachedSetting, setCachedSetting, deleteCachedSetting } from "./settings-cache";

export type ProxyType = "http-connect" | "socks5";

export interface ProxyConfig {
	id: number;
	name: string;
	type: ProxyType;
	host: string;
	port: number;
	username: string | null;
	password: string | null;
	password_enc: string | null;
	is_active: boolean;
	last_used_at: number;
	success_count: number;
	fail_count: number;
	last_ok_at: number | null;
	last_latency_ms: number | null;
	last_error: string | null;
	created_at: number;
	updated_at: number;
}

export type PoolStrategy = "round_robin" | "priority" | "random";

export interface ProxyPool {
	id: number;
	name: string;
	proxy_ids: number[];
	is_active: boolean;
	strategy: PoolStrategy;
	created_at: number;
	updated_at: number;
}

export interface ProxyAssignment {
	proxy_pool_id: number;
	target_type: "provider" | "client_key";
	target_id: string;
	created_at: number;
}

export interface CreateProxyInput {
	name: string;
	type: ProxyType;
	host: string;
	port: number;
	username?: string | null;
	password?: string | null;
	is_active?: boolean;
}

export type UpdateProxyInput = Partial<CreateProxyInput>;

export interface CreatePoolInput {
	name: string;
	proxy_ids?: number[];
	is_active?: boolean;
	strategy?: PoolStrategy;
}

export type UpdatePoolInput = Partial<CreatePoolInput>;

export interface BulkProxyRow {
	name?: string;
	type?: ProxyType;
	host: string;
	port: number;
	username?: string | null;
	password?: string | null;
	poolName?: string;
}

interface ProxyRow {
	id: number;
	name: string;
	type: string;
	host: string;
	port: number;
	username: string | null;
	password_enc: string | null;
	is_active: number;
	last_used_at: number;
	success_count: number;
	fail_count: number;
	last_ok_at: number | null;
	last_latency_ms: number | null;
	last_error: string | null;
	created_at: number;
	updated_at: number;
}

interface PoolRow {
	id: number;
	name: string;
	proxy_ids: string;
	is_active: number;
	strategy?: string;
	created_at: number;
	updated_at: number;
}

interface AssignmentRow {
	proxy_pool_id: number;
	target_type: string;
	target_id: string;
	created_at: number;
}

type ProxyResultQueued = {
	id: number;
	ok: boolean;
	latencyMs: number;
	error: string | null;
	nowMs: number;
	nowSec: number;
};

let proxyVer = -1;
let poolVer = -1;
let assignVer = -1;

let cachedProxies: ProxyConfig[] = [];
let cachedProxiesById = new Map<number, ProxyConfig>();
let cachedPools: ProxyPool[] = [];
let cachedPoolsById = new Map<number, ProxyPool>();
let cachedAssignments: ProxyAssignment[] = [];
let cachedPoolByProvider = new Map<string, ProxyPool>();
let cachedPoolByKey = new Map<number, ProxyPool>();

const pendingStats = new Map<number, { okDelta: number; failDelta: number; lastOkAt: number | null; lastLatencyMs: number; lastError: string | null; lastUsedAt: number; updatedAt: number }>();
let statsTimer: ReturnType<typeof setTimeout> | null = null;

export function flushProxyStats(): void {
	if (statsTimer) {
		clearTimeout(statsTimer);
		statsTimer = null;
	}
	if (pendingStats.size === 0) return;
	const entries = [...pendingStats.entries()];
	pendingStats.clear();

	exec("BEGIN");
	try {
		const stmtOk = query(
			`UPDATE outbound_proxies
			 SET success_count = success_count + ?, fail_count = fail_count + ?,
			     last_ok_at = COALESCE(?, last_ok_at), last_latency_ms = ?, last_error = NULL,
			     last_used_at = ?, updated_at = ?
			 WHERE id = ?`,
		);
		const stmtErr = query(
			`UPDATE outbound_proxies
			 SET success_count = success_count + ?, fail_count = fail_count + ?,
			     last_ok_at = COALESCE(?, last_ok_at), last_latency_ms = ?, last_error = ?,
			     last_used_at = ?, updated_at = ?
			 WHERE id = ?`,
		);
		for (const [id, st] of entries) {
			if (st.lastError === null) {
				stmtOk.run(st.okDelta, st.failDelta, st.lastOkAt, st.lastLatencyMs, st.lastUsedAt, st.updatedAt, id);
			} else {
				stmtErr.run(st.okDelta, st.failDelta, st.lastOkAt, st.lastLatencyMs, st.lastError, st.lastUsedAt, st.updatedAt, id);
			}
		}
		exec("COMMIT");
	} catch (err) {
		exec("ROLLBACK");
		throw err;
	}
}

onBeforeRead("outbound_proxies", flushProxyStats);
onShutdownFlush(flushProxyStats);
onDbReset(() => {
	proxyVer = -1;
	poolVer = -1;
	assignVer = -1;
	cachedProxies = [];
	cachedProxiesById.clear();
	cachedPools = [];
	cachedPoolsById.clear();
	cachedAssignments = [];
	cachedPoolByProvider.clear();
	cachedPoolByKey.clear();
	pendingStats.clear();
	if (statsTimer) {
		clearTimeout(statsTimer);
		statsTimer = null;
	}
});

function decryptKeyOrNull(enc: string): string | null {
	try {
		return decryptKey(enc);
	} catch {
		return hasApiKeySecret() ? null : enc;
	}
}

function mapProxy(row: ProxyRow): ProxyConfig {
	return {
		id: row.id,
		name: row.name,
		type: (row.type === "socks5" ? "socks5" : "http-connect") as ProxyType,
		host: row.host,
		port: row.port,
		username: row.username,
		password: row.password_enc ? decryptKeyOrNull(row.password_enc) : null,
		password_enc: row.password_enc,
		is_active: row.is_active === 1,
		last_used_at: row.last_used_at,
		success_count: row.success_count ?? 0,
		fail_count: row.fail_count ?? 0,
		last_ok_at: row.last_ok_at ?? null,
		last_latency_ms: row.last_latency_ms ?? null,
		last_error: row.last_error ?? null,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

function parseProxyIds(raw: string): number[] {
	try {
		const arr = JSON.parse(raw);
		return Array.isArray(arr)
			? arr.filter((n: unknown) => typeof n === "number")
			: [];
	} catch {
		return [];
	}
}

function mapPool(row: PoolRow): ProxyPool {
	return {
		id: row.id,
		name: row.name,
		proxy_ids: parseProxyIds(row.proxy_ids),
		is_active: row.is_active === 1,
		strategy: (["round_robin", "priority", "random"] as const).includes(
			row.strategy as PoolStrategy,
		)
			? (row.strategy as PoolStrategy)
			: "round_robin",
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

function ensureProxiesCache(): void {
	flushProxyStats();
	const ver = getTableVersion("outbound_proxies");
	if (ver === proxyVer) return;
	const rows = query("SELECT * FROM outbound_proxies ORDER BY name").all() as unknown as ProxyRow[];
	cachedProxies = rows.map(mapProxy);
	cachedProxiesById = new Map(cachedProxies.map((p) => [p.id, p]));
	proxyVer = ver;
}

function ensurePoolsCache(): void {
	const pv = getTableVersion("proxy_pools");
	const av = getTableVersion("proxy_pool_assignments");
	if (pv !== poolVer) {
		const rows = query("SELECT * FROM proxy_pools ORDER BY name").all() as unknown as PoolRow[];
		cachedPools = rows.map(mapPool);
		cachedPoolsById = new Map(cachedPools.map((p) => [p.id, p]));
	}
	if (pv !== poolVer || av !== assignVer) {
		const aRows = query("SELECT * FROM proxy_pool_assignments ORDER BY target_type, target_id").all() as unknown as AssignmentRow[];
		cachedAssignments = aRows.map((r) => ({
			proxy_pool_id: r.proxy_pool_id,
			target_type: (r.target_type === "client_key" ? "client_key" : "provider") as "provider" | "client_key",
			target_id: r.target_id,
			created_at: r.created_at,
		}));
		const byProv = new Map<string, ProxyPool>();
		const byKey = new Map<number, ProxyPool>();
		for (const a of cachedAssignments) {
			const pool = cachedPoolsById.get(a.proxy_pool_id);
			if (!pool || !pool.is_active) continue;
			if (a.target_type === "provider") {
				if (!byProv.has(a.target_id)) byProv.set(a.target_id, pool);
			} else {
				const kid = Number(a.target_id);
				if (Number.isFinite(kid) && !byKey.has(kid)) byKey.set(kid, pool);
			}
		}
		cachedPoolByProvider = byProv;
		cachedPoolByKey = byKey;
		poolVer = pv;
		assignVer = av;
	}
}

export function hasAnyProxyPools(): boolean {
	ensurePoolsCache();
	return cachedPools.length > 0;
}

export function listProxies(activeOnly = false): ProxyConfig[] {
	ensureProxiesCache();
	return activeOnly ? cachedProxies.filter((p) => p.is_active) : cachedProxies;
}

export function getProxy(id: number): ProxyConfig | null {
	ensureProxiesCache();
	return cachedProxiesById.get(id) ?? null;
}

export function createProxy(input: CreateProxyInput): ProxyConfig {
	const passwordEnc = input.password
		? (encryptKey(input.password) ?? input.password)
		: null;
	query(
		`INSERT INTO outbound_proxies (name, type, host, port, username, password_enc, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.name,
		input.type,
		input.host,
		input.port,
		input.username ?? null,
		passwordEnc,
		input.is_active === false ? 0 : 1,
	);
	const row = query("SELECT last_insert_rowid() AS id").get() as { id: number };
	const created = getProxy(row.id);
	if (!created) throw new Error("failed to create proxy");
	return created;
}

export function updateProxy(
	id: number,
	input: UpdateProxyInput,
): ProxyConfig | null {
	const current = getProxy(id);
	if (!current) return null;
	const name = input.name !== undefined ? input.name : current.name;
	const type = input.type !== undefined ? input.type : current.type;
	const host = input.host !== undefined ? input.host : current.host;
	const port = input.port !== undefined ? input.port : current.port;
	const username = input.username !== undefined ? (input.username ?? null) : current.username;
	const passwordEnc =
		input.password !== undefined
			? (input.password ? (encryptKey(input.password) ?? input.password) : null)
			: current.password_enc;
	const isActive = input.is_active !== undefined ? (input.is_active ? 1 : 0) : (current.is_active ? 1 : 0);

	query(
		`UPDATE outbound_proxies
		 SET name = ?, type = ?, host = ?, port = ?, username = ?, password_enc = ?, is_active = ?, updated_at = ?
		 WHERE id = ?`,
	).run(name, type, host, port, username, passwordEnc, isActive, nowSec(), id);
	return getProxy(id);
}

export function deleteProxy(id: number): void {
	deleteProxiesBatch([id]);
}

export function deleteProxiesBatch(ids: number[]): void {
	const idSet = new Set(ids.filter((n) => Number.isFinite(n) && n > 0));
	if (idSet.size === 0) return;
	exec("BEGIN");
	try {
		const delStmt = query("DELETE FROM outbound_proxies WHERE id = ?");
		for (const id of idSet) delStmt.run(id);
		const updatePoolStmt = query(
			"UPDATE proxy_pools SET proxy_ids = ?, updated_at = ? WHERE id = ?",
		);
		const ts = nowSec();
		for (const pool of listPools()) {
			if (pool.proxy_ids.some((pid) => idSet.has(pid))) {
				const rest = pool.proxy_ids.filter((pid) => !idSet.has(pid));
				updatePoolStmt.run(JSON.stringify(rest), ts, pool.id);
			}
		}
		exec("COMMIT");
	} catch (err) {
		exec("ROLLBACK");
		throw err;
	}
}

export function listPools(activeOnly = false): ProxyPool[] {
	ensurePoolsCache();
	return activeOnly ? cachedPools.filter((p) => p.is_active) : cachedPools;
}

export function getPool(id: number): ProxyPool | null {
	ensurePoolsCache();
	return cachedPoolsById.get(id) ?? null;
}

export function createPool(input: CreatePoolInput): ProxyPool {
	query(
		"INSERT INTO proxy_pools (name, proxy_ids, is_active, strategy) VALUES (?, ?, ?, ?)",
	).run(
		input.name,
		JSON.stringify(input.proxy_ids ?? []),
		input.is_active === false ? 0 : 1,
		input.strategy ?? "round_robin",
	);
	const row = query("SELECT last_insert_rowid() AS id").get() as { id: number };
	const created = getPool(row.id);
	if (!created) throw new Error("failed to create pool");
	return created;
}

export function updatePool(
	id: number,
	input: UpdatePoolInput,
): ProxyPool | null {
	const current = getPool(id);
	if (!current) return null;
	const name = input.name !== undefined ? input.name : current.name;
	const proxyIds = input.proxy_ids !== undefined ? JSON.stringify(input.proxy_ids) : JSON.stringify(current.proxy_ids);
	const isActive = input.is_active !== undefined ? (input.is_active ? 1 : 0) : (current.is_active ? 1 : 0);
	const strategy = input.strategy !== undefined ? input.strategy : current.strategy;

	query(
		"UPDATE proxy_pools SET name = ?, proxy_ids = ?, is_active = ?, strategy = ?, updated_at = ? WHERE id = ?",
	).run(name, proxyIds, isActive, strategy, nowSec(), id);
	return getPool(id);
}

export function deletePool(id: number): void {
	exec("BEGIN");
	try {
		query("DELETE FROM proxy_pool_assignments WHERE proxy_pool_id = ?").run(id);
		query("DELETE FROM proxy_pools WHERE id = ?").run(id);
		exec("COMMIT");
	} catch (err) {
		exec("ROLLBACK");
		throw err;
	}
}

export type AssignmentTargetType = "provider" | "client_key";

export interface AssignPoolInput {
	proxyPoolId: number;
	targetType: AssignmentTargetType;
	targetId: string | number;
}

export function assignPool(input: AssignPoolInput): void {
	query(
		`INSERT INTO proxy_pool_assignments (proxy_pool_id, target_type, target_id)
     VALUES (?, ?, ?)
     ON CONFLICT(proxy_pool_id, target_type, target_id) DO NOTHING`,
	).run(input.proxyPoolId, input.targetType, String(input.targetId));
}

export function unassignPool(
	targetType: AssignmentTargetType,
	targetId: string | number,
): void {
	query(
		"DELETE FROM proxy_pool_assignments WHERE target_type = ? AND target_id = ?",
	).run(targetType, String(targetId));
}

export function listAssignments(): ProxyAssignment[] {
	ensurePoolsCache();
	return cachedAssignments;
}

export function getPoolForProvider(providerId: string): ProxyPool | null {
	ensurePoolsCache();
	return cachedPoolByProvider.get(providerId) ?? null;
}

export function getPoolForApiKey(apiKeyId: number): ProxyPool | null {
	ensurePoolsCache();
	return cachedPoolByKey.get(apiKeyId) ?? null;
}

export function bulkImportProxies(rows: BulkProxyRow[]): {
	imported: number;
	errors: string[];
} {
	let imported = 0;
	const errors: string[] = [];
	const poolAdditions = new Map<string, number[]>();

	exec("BEGIN");
	try {
		for (const [i, row] of rows.entries()) {
			try {
				if (!row.host || !row.port) {
					errors.push(`row ${i + 1}: host and port required`);
					continue;
				}
				const proxy = createProxy({
					name: row.name || `${row.host}:${row.port}`,
					type: row.type ?? "http-connect",
					host: row.host,
					port: row.port,
					username: row.username ?? null,
					password: row.password ?? null,
				});
				imported++;
				if (row.poolName) {
					let arr = poolAdditions.get(row.poolName);
					if (!arr) {
						arr = [];
						poolAdditions.set(row.poolName, arr);
					}
					arr.push(proxy.id);
				}
			} catch (err) {
				errors.push(
					`row ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		for (const [poolName, addedIds] of poolAdditions) {
			const existing = listPools().find((p) => p.name === poolName);
			if (!existing) {
				createPool({ name: poolName, proxy_ids: addedIds });
			} else {
				updatePool(existing.id, { proxy_ids: [...existing.proxy_ids, ...addedIds] });
			}
		}
		exec("COMMIT");
	} catch (err) {
		exec("ROLLBACK");
		throw err;
	}
	return { imported, errors };
}

const GLOBAL_POOL_SETTING = "global_proxy_pool_id";

export function getGlobalProxyPool(): ProxyPool | null {
	const raw = getCachedSetting(GLOBAL_POOL_SETTING);
	if (!raw) return null;
	return getPool(Number(raw));
}

export function setGlobalProxyPool(poolId: number | null): void {
	if (poolId == null || Number.isNaN(poolId)) {
		deleteCachedSetting(GLOBAL_POOL_SETTING);
	} else {
		setCachedSetting(GLOBAL_POOL_SETTING, String(poolId));
	}
}

export interface ProxyResultInput {
	ok: boolean;
	latencyMs: number;
	error?: string;
}

export function recordProxyResult(id: number, input: ProxyResultInput): void {
	if (id <= 0) return;
	const nowMs = Date.now();
	const nowS = Math.floor(nowMs / 1000);
	const existing = pendingStats.get(id) ?? {
		okDelta: 0,
		failDelta: 0,
		lastOkAt: null,
		lastLatencyMs: input.latencyMs,
		lastError: null,
		lastUsedAt: nowS,
		updatedAt: nowS,
	};
	if (input.ok) {
		existing.okDelta += 1;
		existing.lastOkAt = nowMs;
		existing.lastError = null;
	} else {
		existing.failDelta += 1;
		existing.lastError = input.error ?? "unknown error";
	}
	existing.lastLatencyMs = input.latencyMs;
	existing.lastUsedAt = nowS;
	existing.updatedAt = nowS;
	pendingStats.set(id, existing);

	const cached = cachedProxiesById.get(id);
	if (cached) {
		if (input.ok) {
			cached.success_count += 1;
			cached.last_ok_at = nowMs;
			cached.last_error = null;
		} else {
			cached.fail_count += 1;
			cached.last_error = existing.lastError;
		}
		cached.last_latency_ms = input.latencyMs;
		cached.last_used_at = nowS;
		cached.updated_at = nowS;
	}

	if (!statsTimer) {
		statsTimer = setTimeout(flushProxyStats, 2000);
		statsTimer.unref?.();
	}
}
