import { query } from "./db";
import { encryptKey, decryptKey } from "./key-crypto";

export type ProxyType = "http-connect" | "socks5";

export interface ProxyConfig {
	id: number;
	name: string;
	type: ProxyType;
	host: string;
	port: number;
	username: string | null;
	/** Decrypted password (only exposed by getProxy when explicitly requested). */
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

export interface ProxyPool {
	id: number;
	name: string;
	proxy_ids: number[];
	is_active: boolean;
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
	created_at: number;
	updated_at: number;
}

interface AssignmentRow {
	proxy_pool_id: number;
	target_type: string;
	target_id: string;
	created_at: number;
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

function mapPool(row: PoolRow): ProxyPool {
	return {
		id: row.id,
		name: row.name,
		proxy_ids: parseProxyIds(row.proxy_ids),
		is_active: row.is_active === 1,
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

function decryptKeyOrNull(enc: string): string | null {
	try {
		return decryptKey(enc);
	} catch {
		// Not encrypted (no API_KEY_SECRET was configured when stored) — treat as plaintext.
		return enc;
	}
}

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Proxies
// ---------------------------------------------------------------------------

export function listProxies(activeOnly = false): ProxyConfig[] {
	const sql = activeOnly
		? "SELECT * FROM outbound_proxies WHERE is_active = 1 ORDER BY name"
		: "SELECT * FROM outbound_proxies ORDER BY name";
	return (query(sql).all() as unknown as ProxyRow[]).map(mapProxy);
}

export function getProxy(id: number): ProxyConfig | null {
	const row = query("SELECT * FROM outbound_proxies WHERE id = ?").get(id) as
		| ProxyRow
		| undefined;
	return row ? mapProxy(row) : null;
}

export function createProxy(input: CreateProxyInput): ProxyConfig {
	// Prefer encrypted-at-rest; fall back to plaintext when no API_KEY_SECRET set.
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
	// Fully static SQL per field; values are parameterized.
	const stmts: Array<{ sql: string; value: unknown }> = [];
	if (input.name !== undefined) {
		stmts.push({
			sql: "UPDATE outbound_proxies SET name = ? WHERE id = ?",
			value: input.name,
		});
	}
	if (input.type !== undefined) {
		stmts.push({
			sql: "UPDATE outbound_proxies SET type = ? WHERE id = ?",
			value: input.type,
		});
	}
	if (input.host !== undefined) {
		stmts.push({
			sql: "UPDATE outbound_proxies SET host = ? WHERE id = ?",
			value: input.host,
		});
	}
	if (input.port !== undefined) {
		stmts.push({
			sql: "UPDATE outbound_proxies SET port = ? WHERE id = ?",
			value: input.port,
		});
	}
	if (input.username !== undefined) {
		stmts.push({
			sql: "UPDATE outbound_proxies SET username = ? WHERE id = ?",
			value: input.username ?? null,
		});
	}
	if (input.password !== undefined) {
		// Explicit password set: empty string clears it, otherwise encrypt.
		stmts.push({
			sql: "UPDATE outbound_proxies SET password_enc = ? WHERE id = ?",
			value: input.password
				? (encryptKey(input.password) ?? input.password)
				: null,
		});
	}
	if (input.is_active !== undefined) {
		stmts.push({
			sql: "UPDATE outbound_proxies SET is_active = ? WHERE id = ?",
			value: input.is_active ? 1 : 0,
		});
	}
	if (stmts.length === 0) return current;
	for (const s of stmts) {
		query(s.sql).run(s.value, id);
	}
	query("UPDATE outbound_proxies SET updated_at = ? WHERE id = ?").run(
		nowSec(),
		id,
	);
	return getProxy(id);
}

export function deleteProxy(id: number): void {
	query("DELETE FROM outbound_proxies WHERE id = ?").run(id);
	// Remove the proxy id from every pool's proxy_ids list.
	for (const pool of listPools()) {
		if (pool.proxy_ids.includes(id)) {
			const rest = pool.proxy_ids.filter((pid) => pid !== id);
			query(
				"UPDATE proxy_pools SET proxy_ids = ?, updated_at = ? WHERE id = ?",
			).run(JSON.stringify(rest), nowSec(), pool.id);
		}
	}
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

export function listPools(activeOnly = false): ProxyPool[] {
	const sql = activeOnly
		? "SELECT * FROM proxy_pools WHERE is_active = 1 ORDER BY name"
		: "SELECT * FROM proxy_pools ORDER BY name";
	return (query(sql).all() as unknown as PoolRow[]).map(mapPool);
}

export function getPool(id: number): ProxyPool | null {
	const row = query("SELECT * FROM proxy_pools WHERE id = ?").get(id) as
		| PoolRow
		| undefined;
	return row ? mapPool(row) : null;
}

export function createPool(input: CreatePoolInput): ProxyPool {
	query(
		"INSERT INTO proxy_pools (name, proxy_ids, is_active) VALUES (?, ?, ?)",
	).run(
		input.name,
		JSON.stringify(input.proxy_ids ?? []),
		input.is_active === false ? 0 : 1,
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
	// Fully static SQL per field; values are parameterized.
	const stmts: Array<{ sql: string; value: unknown }> = [];
	if (input.name !== undefined) {
		stmts.push({
			sql: "UPDATE proxy_pools SET name = ? WHERE id = ?",
			value: input.name,
		});
	}
	if (input.proxy_ids !== undefined) {
		stmts.push({
			sql: "UPDATE proxy_pools SET proxy_ids = ? WHERE id = ?",
			value: JSON.stringify(input.proxy_ids),
		});
	}
	if (input.is_active !== undefined) {
		stmts.push({
			sql: "UPDATE proxy_pools SET is_active = ? WHERE id = ?",
			value: input.is_active ? 1 : 0,
		});
	}
	if (stmts.length === 0) return current;
	for (const s of stmts) {
		query(s.sql).run(s.value, id);
	}
	query("UPDATE proxy_pools SET updated_at = ? WHERE id = ?").run(nowSec(), id);
	return getPool(id);
}

export function deletePool(id: number): void {
	query("DELETE FROM proxy_pool_assignments WHERE proxy_pool_id = ?").run(id);
	query("DELETE FROM proxy_pools WHERE id = ?").run(id);
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

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
	return (
		query(
			"SELECT * FROM proxy_pool_assignments ORDER BY target_type, target_id",
		).all() as unknown as AssignmentRow[]
	).map((r) => ({
		proxy_pool_id: r.proxy_pool_id,
		target_type: (r.target_type === "client_key" ? "client_key" : "provider") as
			| "provider"
			| "client_key",
		target_id: r.target_id,
		created_at: r.created_at,
	}));
}

export function getPoolForProvider(providerId: string): ProxyPool | null {
	const row = query(
		`SELECT p.* FROM proxy_pools p
     JOIN proxy_pool_assignments a ON a.proxy_pool_id = p.id
     WHERE a.target_type = 'provider' AND a.target_id = ? AND p.is_active = 1
     LIMIT 1`,
	).get(providerId) as PoolRow | undefined;
	return row ? mapPool(row) : null;
}

export function getPoolForApiKey(apiKeyId: number): ProxyPool | null {
	const row = query(
		`SELECT p.* FROM proxy_pools p
     JOIN proxy_pool_assignments a ON a.proxy_pool_id = p.id
     WHERE a.target_type = 'client_key' AND a.target_id = ? AND p.is_active = 1
     LIMIT 1`,
	).get(String(apiKeyId)) as PoolRow | undefined;
	return row ? mapPool(row) : null;
}

// ---------------------------------------------------------------------------
// Bulk import
// ---------------------------------------------------------------------------

export function bulkImportProxies(rows: BulkProxyRow[]): {
	imported: number;
	errors: string[];
} {
	let imported = 0;
	const errors: string[] = [];
	const poolCache = new Map<string, ProxyPool>();

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
				let pool = poolCache.get(row.poolName);
				if (!pool) {
					pool = listPools().find((p) => p.name === row.poolName) ?? undefined;
					if (!pool) {
						pool = createPool({ name: row.poolName, proxy_ids: [] });
					}
					poolCache.set(row.poolName, pool);
				}
				updatePool(pool.id, { proxy_ids: [...pool.proxy_ids, proxy.id] });
				const refreshed = getPool(pool.id);
				if (refreshed) {
					pool = refreshed;
					poolCache.set(row.poolName, refreshed);
				}
			}
		} catch (err) {
			errors.push(
				`row ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	return { imported, errors };
}

// ---------------------------------------------------------------------------
// Global proxy (default fallback before direct connection)
// ---------------------------------------------------------------------------

const GLOBAL_POOL_SETTING = "global_proxy_pool_id";

/** Global fallback pool applied when neither the API key nor the provider has a pool. */
export function getGlobalProxyPool(): ProxyPool | null {
	const row = query("SELECT value FROM settings WHERE key = ?").get(
		GLOBAL_POOL_SETTING,
	) as { value: string } | undefined;
	if (!row || !row.value) return null;
	return getPool(Number(row.value));
}

export function setGlobalProxyPool(poolId: number | null): void {
	if (poolId == null || Number.isNaN(poolId)) {
		query("DELETE FROM settings WHERE key = ?").run(GLOBAL_POOL_SETTING);
	} else {
		query(
			"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		).run(GLOBAL_POOL_SETTING, String(poolId));
	}
}

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

export interface ProxyResultInput {
	ok: boolean;
	latencyMs: number;
	error?: string;
}

/** Update usage stats for a proxy after a fetch attempt. */
export function recordProxyResult(id: number, input: ProxyResultInput): void {
	if (id <= 0) return;
	if (input.ok) {
		query(
			"UPDATE outbound_proxies SET success_count = success_count + 1, last_ok_at = ?, last_latency_ms = ?, last_error = NULL WHERE id = ?",
		).run(Date.now(), input.latencyMs, id);
	} else {
		query(
			"UPDATE outbound_proxies SET fail_count = fail_count + 1, last_error = ?, last_latency_ms = ? WHERE id = ?",
		).run(input.error ?? "unknown error", input.latencyMs, id);
	}
	const nowSec = Math.floor(Date.now() / 1000);
	query(
		"UPDATE outbound_proxies SET last_used_at = ?, updated_at = ? WHERE id = ?",
	).run(nowSec, nowSec, id);
}
