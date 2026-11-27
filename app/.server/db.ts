import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";

type SqliteApi = {
	exec(sql: string): void;
	close(): void;
};

type StatementApi = {
	run(...params: unknown[]): unknown;
	get(...params: unknown[]): Record<string, unknown> | undefined;
	all(...params: unknown[]): Record<string, unknown>[];
};

const require = createRequire(import.meta.url);

const DB_STATE_SYMBOL = Symbol.for("uniroute.dbState");
type DbState = {
	db: SqliteApi | undefined;
	opened: boolean;
	seeded: boolean;
	stmtCache: Map<string, StatementApi>;
	columnCache: Map<string, Set<string>>;
	resetCallbacks: Set<() => void>;
	tableVersions: Map<string, number>;
	beforeReadHooks: Map<string, Set<() => void>>;
	shutdownFlushers: Set<() => void>;
};
const gDb = globalThis as Record<symbol, DbState | undefined>;
const dbState: DbState =
	gDb[DB_STATE_SYMBOL] ??
	(gDb[DB_STATE_SYMBOL] = {
		db: undefined,
		opened: false,
		seeded: false,
		stmtCache: new Map<string, StatementApi>(),
		columnCache: new Map<string, Set<string>>(),
		resetCallbacks: new Set<() => void>(),
		tableVersions: new Map<string, number>(),
		beforeReadHooks: new Map<string, Set<() => void>>(),
		shutdownFlushers: new Set<() => void>(),
	});

const stmtCache = dbState.stmtCache;
const columnCache = dbState.columnCache;
const resetCallbacks = dbState.resetCallbacks;

export function onDbReset(fn: () => void): void {
	resetCallbacks.add(fn);
}

export function onShutdownFlush(fn: () => void): void {
	dbState.shutdownFlushers.add(fn);
}

export function runShutdownFlushers(): void {
	for (const fn of dbState.shutdownFlushers) {
		try {
			fn();
		} catch {
			/* ignore */
		}
	}
}

function getTableColumns(table: string): Set<string> {
	if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
		throw new Error("invalid sql identifier: " + table);
	}
	const cached = columnCache.get(table);
	if (cached) return cached;
	const cols = new Set(
		(query("PRAGMA table_info(" + table + ")").all() as { name: string }[]).map(
			(c) => c.name,
		),
	);
	columnCache.set(table, cols);
	return cols;
}

export function hasColumn(table: string, column: string): boolean {
	ensureDb();
	if (!/^[a-z_][a-z0-9_]*$/i.test(column)) return false;
	return getTableColumns(table).has(column);
}

function openDb(): void {
	const dbPath = process.env.DATABASE_URL ?? "./data/uniroute.db";
	mkdirSync(path.dirname(dbPath), { recursive: true });
	let conn: SqliteApi;
	try {
		const { Database } = require("bun:sqlite") as {
			Database: new (p: string, opts: { create: boolean }) => SqliteApi;
		};
		conn = new Database(dbPath, { create: true });
	} catch {
		const { DatabaseSync } = require("node:sqlite") as {
			DatabaseSync: new (p: string) => SqliteApi;
		};
		conn = new DatabaseSync(dbPath);
	}
	conn.exec("PRAGMA journal_mode = WAL;");
	conn.exec("PRAGMA synchronous = NORMAL;");
	conn.exec("PRAGMA foreign_keys = ON;");
	conn.exec("PRAGMA busy_timeout = 5000;");
	conn.exec("PRAGMA cache_size = -4000;");
	conn.exec("PRAGMA temp_store = MEMORY;");
	try {
		conn.exec("PRAGMA mmap_size = 0;");
	} catch {
		/* ignore */
	}
	dbState.db = conn;
	dbState.opened = true;
	columnCache.clear();
	try {
		initSchema();
	} catch (err) {
		dbState.opened = false;
		throw err;
	}
}

function ensureDb(): SqliteApi {
	if (!dbState.opened || !dbState.db) {
		openDb();
	}
	return dbState.db!;
}

const TRACKED_TABLES = [
	"providers",
	"models",
	"model_allowlist",
	"routing_rules",
	"load_balancing",
	"compression_settings",
	"provider_credentials",
	"client_api_keys",
	"settings",
	"model_pricing",
	"combos",
	"combo_steps",
	"outbound_proxies",
	"proxy_pools",
	"proxy_pool_assignments",
	"key_groups",
	"key_group_members",
	"request_logs",
] as const;

const tableVersions = dbState.tableVersions;
const beforeReadHooks = dbState.beforeReadHooks;

export function getTableVersion(table: string): number {
	ensureDb();
	return tableVersions.get(table) ?? 0;
}

export function bumpTableVersion(table: string): void {
	tableVersions.set(table, (tableVersions.get(table) ?? 0) + 1);
}

export function onBeforeRead(table: string, fn: () => void): void {
	let set = beforeReadHooks.get(table);
	if (!set) {
		set = new Set();
		beforeReadHooks.set(table, set);
	}
	set.add(fn);
}

function detectWrittenTables(sql: string): string[] {
	if (!/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) return [];
	const lower = sql.toLowerCase();
	const hit: string[] = [];
	for (const t of TRACKED_TABLES) {
		if (lower.includes(t)) hit.push(t);
	}
	return hit;
}

const READ_BARRIER_TABLES = ["request_logs", "proxy_logs", "combo_metrics", "key_usage_daily", "key_audit_logs", "outbound_proxies"] as const;

function detectReadTables(sql: string): string[] {
	if (!/^\s*SELECT\b/i.test(sql)) return [];
	const lower = sql.toLowerCase();
	const hit: string[] = [];
	for (const t of READ_BARRIER_TABLES) {
		if (lower.includes(t)) hit.push(t);
	}
	return hit;
}

function runReadBarriers(tables: string[]): void {
	for (const t of tables) {
		const hooks = beforeReadHooks.get(t);
		if (!hooks) continue;
		for (const fn of hooks) fn();
	}
}

function wrapStatement(stmt: StatementApi, writeTables: string[], readTables: string[]): StatementApi {
	if (writeTables.length === 0 && readTables.length === 0) return stmt;
	return {
		get: (...params: unknown[]) => {
			if (readTables.length > 0) runReadBarriers(readTables);
			return stmt.get(...params);
		},
		all: (...params: unknown[]) => {
			if (readTables.length > 0) runReadBarriers(readTables);
			return stmt.all(...params);
		},
		run: (...params: unknown[]) => {
			const res = stmt.run(...params);
			for (const t of writeTables) bumpTableVersion(t);
			return res;
		},
	};
}

export function query(sql: string): StatementApi {
	const conn = ensureDb();
	const cached = stmtCache.get(sql);
	if (cached) return cached;

	const q = (conn as { query?: (sql: string) => unknown }).query;
	const prepare = (conn as { prepare?: (sql: string) => unknown }).prepare;
	let stmt: StatementApi | undefined;
	if (typeof q === "function") {
		stmt = q.call(conn, sql) as StatementApi;
	} else if (typeof prepare === "function") {
		stmt = prepare.call(conn, sql) as StatementApi;
	}
	if (!stmt) throw new Error("sqlite API not available");

	const writeTables = detectWrittenTables(sql);
	const readTables = detectReadTables(sql);
	const wrapped = wrapStatement(stmt, writeTables, readTables);
	stmtCache.set(sql, wrapped);
	return wrapped;
}

export const exec = (sql: string): void => {
	ensureDb().exec(sql);
	for (const t of detectWrittenTables(sql)) {
		bumpTableVersion(t);
	}
};

export function closeDb(): void {
	try {
		if (dbState.opened && dbState.db) dbState.db.close();
	} catch {
		/* already closed */
	}
	dbState.db = undefined;
	dbState.opened = false;
	dbState.seeded = false;
	stmtCache.clear();
	columnCache.clear();
	tableVersions.clear();
	for (const fn of resetCallbacks) {
		try {
			fn();
		} catch {
			/* ignore */
		}
	}
}

export function resetDb(): void {
	closeDb();
}

function ensureColumn(table: string, column: string, ddl: string): void {
	if (
		!/^[a-z_][a-z0-9_]*$/i.test(table) ||
		!/^[a-z_][a-z0-9_]*$/i.test(column)
	) {
		throw new Error("invalid sql identifier: " + table + "." + column);
	}
	const cols = getTableColumns(table);
	if (!cols.has(column)) {
		ensureDb().exec("ALTER TABLE " + table + " ADD COLUMN " + ddl + ";");
		cols.add(column);
	}
}

function initSchema(): void {
	const conn = dbState.db!;
	conn.exec(`CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'bearer',
  is_active INTEGER NOT NULL DEFAULT 1,
  weight INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  current_connections INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);`);

	conn.exec(`CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  context_length INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_primary INTEGER NOT NULL DEFAULT 0,
  UNIQUE(model_name, provider_id)
);`);

	conn.exec(`CREATE TABLE IF NOT EXISTS model_allowlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'allow',
  reason TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(model_name, action)
);`);

	conn.exec(`CREATE TABLE IF NOT EXISTS routing_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source_model TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  target_model TEXT,
  target_provider_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);`);

	conn.exec(`CREATE TABLE IF NOT EXISTS load_balancing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name TEXT NOT NULL UNIQUE,
  strategy TEXT NOT NULL DEFAULT 'round_robin',
  fallback_enabled INTEGER NOT NULL DEFAULT 1,
  health_check_enabled INTEGER NOT NULL DEFAULT 0,
  health_check_url TEXT,
  health_check_interval INTEGER DEFAULT 60,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);`);

	conn.exec(`CREATE TABLE IF NOT EXISTS compression_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rtk_enabled INTEGER NOT NULL DEFAULT 0,
  caveman_enabled INTEGER NOT NULL DEFAULT 0,
  rtk_binary_path TEXT DEFAULT '',
  caveman_binary_path TEXT DEFAULT '',
  rtk_filter TEXT NOT NULL DEFAULT 'auto',
  caveman_type TEXT NOT NULL DEFAULT 'auto',
  updated_at INTEGER DEFAULT (unixepoch())
);`);

	conn.exec(`CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model TEXT,
  provider_id TEXT,
  strategy_used TEXT,
  rule_applied TEXT,
  duration_ms INTEGER,
  status TEXT,
  error_message TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  api_key_id INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);`);

	conn.exec(`CREATE TABLE IF NOT EXISTS proxy_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);`);
	conn.exec(`CREATE TABLE IF NOT EXISTS outbound_proxies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'http-connect',  -- 'http-connect' | 'socks5'
  host         TEXT NOT NULL,
  port         INTEGER NOT NULL,
  username     TEXT,
  password_enc TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  last_used_at INTEGER DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  last_ok_at    INTEGER,
  last_latency_ms INTEGER,
  last_error    TEXT,
  created_at   INTEGER DEFAULT (unixepoch()),
  updated_at   INTEGER DEFAULT (unixepoch())
);`);
	conn.exec(`CREATE TABLE IF NOT EXISTS proxy_pools (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  proxy_ids  TEXT NOT NULL,                          -- JSON array of outbound_proxies.id
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);`);
	conn.exec(`CREATE TABLE IF NOT EXISTS proxy_pool_assignments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  proxy_pool_id INTEGER NOT NULL,
  target_type   TEXT NOT NULL,                        -- 'provider' | 'client_key'
  target_id     TEXT NOT NULL,
  created_at    INTEGER DEFAULT (unixepoch()),
  UNIQUE(proxy_pool_id, target_type, target_id)
);`);

	conn.exec(`CREATE TABLE IF NOT EXISTS provider_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  label TEXT,
  api_key TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_routing INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);`);

	conn.exec(`CREATE TABLE IF NOT EXISTS client_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  key_prefix TEXT NOT NULL,
  allowed_models TEXT,
  model_override TEXT,
  pinned_provider_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  description TEXT,
  key_enc TEXT,
  previous_key_hash TEXT,
  previous_key_enc TEXT,
  previous_expires_at INTEGER,
  blocked_models TEXT,
  allowed_providers TEXT,
  blocked_providers TEXT,
  budget TEXT,
  quota TEXT,
  alert_threshold REAL,
  auto_block INTEGER NOT NULL DEFAULT 0,
  blocked_at INTEGER,
  ip_whitelist TEXT,
  ip_blacklist TEXT,
  strict_ip INTEGER NOT NULL DEFAULT 0,
  access_hours TEXT,
  expires_at INTEGER,
  rotation_interval_days INTEGER,
  grace_period_days INTEGER,
  webhook_url TEXT,
  scopes TEXT
);`);

	conn.exec(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);`);

	// Legacy DB migration: add API Manager columns if the table predates them.
	{
		const keyCols: Array<[string, string]> = [
			["description", "description TEXT"],
			["key_enc", "key_enc TEXT"],
			["previous_key_hash", "previous_key_hash TEXT"],
			["previous_key_enc", "previous_key_enc TEXT"],
			["previous_expires_at", "previous_expires_at INTEGER"],
			["blocked_models", "blocked_models TEXT"],
			["allowed_providers", "allowed_providers TEXT"],
			["blocked_providers", "blocked_providers TEXT"],
			["budget", "budget TEXT"],
			["quota", "quota TEXT"],
			["alert_threshold", "alert_threshold REAL"],
			["auto_block", "auto_block INTEGER NOT NULL DEFAULT 0"],
			["blocked_at", "blocked_at INTEGER"],
			["ip_whitelist", "ip_whitelist TEXT"],
			["ip_blacklist", "ip_blacklist TEXT"],
			["strict_ip", "strict_ip INTEGER NOT NULL DEFAULT 0"],
			["access_hours", "access_hours TEXT"],
			["expires_at", "expires_at INTEGER"],
			["rotation_interval_days", "rotation_interval_days INTEGER"],
			["grace_period_days", "grace_period_days INTEGER"],
			["webhook_url", "webhook_url TEXT"],
			["scopes", "scopes TEXT"],
		];
		for (const [col, ddl] of keyCols) {
			ensureColumn("client_api_keys", col, ddl);
		}
		ensureColumn("request_logs", "api_key_id", "api_key_id INTEGER");
	}

	conn.exec(`CREATE TABLE IF NOT EXISTS key_usage_daily (
  key_id INTEGER NOT NULL REFERENCES client_api_keys(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, date)
);`);

	conn.exec(`CREATE TABLE IF NOT EXISTS key_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  model TEXT,
  provider_id TEXT,
  status INTEGER,
  tokens INTEGER,
  cost REAL,
  details TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_audit_key ON key_audit_logs (key_id, created_at);`);

	conn.exec(`CREATE TABLE IF NOT EXISTS model_pricing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  input_per_mtok REAL NOT NULL DEFAULT 0,
  output_per_mtok REAL NOT NULL DEFAULT 0,
  updated_at INTEGER DEFAULT (unixepoch()),
  UNIQUE (model, provider_id)
);`);

	conn.exec(`CREATE TABLE IF NOT EXISTS key_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  config TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);`);

	conn.exec(`CREATE TABLE IF NOT EXISTS key_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  shared_quota TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);`);

	conn.exec(`CREATE TABLE IF NOT EXISTS key_group_members (
  group_id INTEGER NOT NULL REFERENCES key_groups(id) ON DELETE CASCADE,
  key_id INTEGER NOT NULL REFERENCES client_api_keys(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, key_id)
);`);

	conn.exec(`CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id INTEGER REFERENCES client_api_keys(id) ON DELETE SET NULL,
  event TEXT NOT NULL,
  url TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  next_retry_at INTEGER DEFAULT (unixepoch()),
  created_at INTEGER DEFAULT (unixepoch())
);`);

	conn.exec(`CREATE TABLE IF NOT EXISTS combos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  strategy TEXT NOT NULL DEFAULT 'priority',
  config TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);`);
	conn.exec(`CREATE TABLE IF NOT EXISTS combo_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  combo_id INTEGER NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  provider_id TEXT,
  model_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  prompt TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);`);
	conn.exec(`CREATE TABLE IF NOT EXISTS combo_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  combo_id INTEGER NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  combo_name TEXT,
  strategy TEXT,
  step_index INTEGER,
  model_id TEXT,
  provider_id TEXT,
  timestamp INTEGER DEFAULT (unixepoch()),
  latency_ms INTEGER,
  cost REAL,
  success INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER,
  error TEXT
);`);

  ensureColumn("combo_steps", "model_ids", "model_ids TEXT");
  ensureColumn("combo_steps", "account_id", "account_id INTEGER");
  ensureColumn("combo_steps", "account_ids", "account_ids TEXT");
	ensureColumn("provider_credentials", "proxy_pool_id", "proxy_pool_id INTEGER");
	ensureColumn("proxy_pools", "strategy", "strategy TEXT NOT NULL DEFAULT 'round_robin'");
	ensureColumn(
		"request_logs",
		"via_proxy",
		"via_proxy INTEGER NOT NULL DEFAULT 0",
	);
	ensureColumn("request_logs", "proxy_id", "proxy_id INTEGER");
	ensureColumn("request_logs", "endpoint", "endpoint TEXT");
	ensureColumn("request_logs", "upstream_tls", "upstream_tls INTEGER");
	ensureColumn("request_logs", "cached_tokens", "cached_tokens INTEGER");
	ensureColumn("proxy_logs", "client_ip", "client_ip TEXT");
	ensureColumn("proxy_logs", "api_key_id", "api_key_id INTEGER");
	ensureColumn("proxy_logs", "provider_id", "provider_id TEXT");
	ensureColumn("proxy_logs", "proxy_id", "proxy_id INTEGER");
	ensureColumn("proxy_logs", "latency_ms", "latency_ms INTEGER");
	ensureColumn("proxy_logs", "endpoint", "endpoint TEXT");
	ensureColumn("providers", "prefix", "prefix TEXT");
	ensureColumn("models", "display_name", "display_name TEXT");
	ensureColumn(
		"compression_settings",
		"rtk_filter",
		"rtk_filter TEXT NOT NULL DEFAULT 'auto'",
	);
	ensureColumn(
		"compression_settings",
		"caveman_type",
		"caveman_type TEXT NOT NULL DEFAULT 'auto'",
	);
	ensureColumn(
		"compression_settings",
		"caveman_voice",
		"caveman_voice TEXT NOT NULL DEFAULT 'off'",
	);
	ensureColumn(
		"compression_settings",
		"scope",
		"scope TEXT NOT NULL DEFAULT 'tool_and_last'",
	);
	ensureColumn(
		"compression_settings",
		"min_chars",
		"min_chars INTEGER NOT NULL DEFAULT 400",
	);
	ensureColumn(
		"compression_settings",
		"timeout_ms",
		"timeout_ms INTEGER NOT NULL DEFAULT 5000",
	);
	ensureColumn(
		"compression_settings",
		"never_worse",
		"never_worse INTEGER NOT NULL DEFAULT 1",
	);
	// Legacy prefix migration ("openai/" -> "openai"): clear empty values to NULL.
	try {
		conn.exec(
			"UPDATE providers SET prefix = TRIM(TRIM(prefix), '/') WHERE prefix IS NOT NULL;",
		);
		conn.exec("UPDATE providers SET prefix = NULL WHERE prefix = '';");
	} catch {
		/* providers table may not exist yet during fresh init */
	}

	conn.exec(`CREATE TABLE IF NOT EXISTS chat_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'New chat',
  model TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_provider ON chat_sessions (provider_id, updated_at);`);

  ensureColumn("chat_messages", "thinking", "thinking TEXT");


	ensureColumn("outbound_proxies", "success_count", "success_count INTEGER NOT NULL DEFAULT 0");
	ensureColumn("outbound_proxies", "fail_count", "fail_count INTEGER NOT NULL DEFAULT 0");
	ensureColumn("outbound_proxies", "last_ok_at", "last_ok_at INTEGER");
	ensureColumn("outbound_proxies", "last_latency_ms", "last_latency_ms INTEGER");
	ensureColumn("outbound_proxies", "last_error", "last_error TEXT");

	conn.exec(`CREATE INDEX IF NOT EXISTS idx_request_logs_created_at
    ON request_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_status_created
    ON request_logs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_apikey_created
    ON request_logs (api_key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_created_duration
    ON request_logs (created_at, duration_ms);
CREATE INDEX IF NOT EXISTS idx_proxy_logs_created_at
    ON proxy_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_combo_metrics_ts
    ON combo_metrics (timestamp);
CREATE INDEX IF NOT EXISTS idx_combo_metrics_combo_ts
    ON combo_metrics (combo_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_combo_steps_combo
    ON combo_steps (combo_id, step_order);
CREATE INDEX IF NOT EXISTS idx_webhook_events_retry
    ON webhook_events (status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_models_provider_active
    ON models (provider_id, is_active);
CREATE INDEX IF NOT EXISTS idx_models_display_name
    ON models (display_name) WHERE display_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_provider_creds_provider
    ON provider_credentials (provider_id, is_active, is_routing);
CREATE INDEX IF NOT EXISTS idx_routing_rules_source
    ON routing_rules (source_model, is_active, priority DESC);
CREATE INDEX IF NOT EXISTS idx_client_keys_prev_hash
    ON client_api_keys (previous_key_hash) WHERE previous_key_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proxy_assign_target
    ON proxy_pool_assignments (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_key_group_members_key
    ON key_group_members (key_id);
CREATE INDEX IF NOT EXISTS idx_audit_key_action_created
    ON key_audit_logs (key_id, action, created_at);`);

	// Migrate legacy single-key table (provider_id PRIMARY KEY) to multi-key schema.
	{
		const cols = (
			query("PRAGMA table_info(provider_credentials)").all() as {
				name: string;
			}[]
		).map((c) => c.name);
		if (cols.length > 0 && !cols.includes("id")) {
			conn.exec(
				"ALTER TABLE provider_credentials RENAME TO provider_credentials_legacy;",
			);
			conn.exec(`CREATE TABLE provider_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT NOT NULL,
      label TEXT,
      api_key TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_routing INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );`);
			conn.exec(`INSERT INTO provider_credentials (provider_id, api_key, is_routing, updated_at)
             SELECT provider_id, api_key, 1, updated_at FROM provider_credentials_legacy;`);
			conn.exec("DROP TABLE provider_credentials_legacy;");
		}
	}

	{
		const modelCols = (
			query("PRAGMA table_info(models)").all() as {
				name: string;
			}[]
		).map((c) => c.name);
		if (modelCols.length > 0 && !modelCols.includes("is_public")) {
			conn.exec(
				"ALTER TABLE models ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0",
			);
		}
	}
}

export function seed() {
	const count =
		(
			query("SELECT COUNT(*) AS c FROM providers").get() as
				| {
						c: number;
				  }
				| undefined
		)?.c ?? 0;
	if (count > 0) return;

	const insertProvider = query(
		`INSERT INTO providers (id, name, base_url, auth_type, is_active, weight, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	const insertModel = query(
		`INSERT INTO models (model_name, provider_id, context_length, is_active, is_primary)
     VALUES (?, ?, ?, ?, ?)`,
	);

	exec("BEGIN");
	try {
		insertProvider.run(
			"openai",
			"OpenAI",
			"https://api.openai.com",
			"bearer",
			0,
			3,
			2,
		);
		insertProvider.run(
			"anthropic",
			"Anthropic",
			"https://api.anthropic.com",
			"bearer",
			0,
			1,
			1,
		);
		insertProvider.run(
			"google",
			"Google",
			"https://generativelanguage.googleapis.com",
			"apikey",
			0,
			1,
			0,
		);
		insertProvider.run(
			"groq",
			"Groq",
			"https://api.groq.com",
			"bearer",
			0,
			1,
			1,
		);
		insertProvider.run(
			"openrouter",
			"OpenRouter",
			"https://openrouter.ai",
			"bearer",
			0,
			2,
			0,
		);
		insertProvider.run(
			"mistral",
			"Mistral",
			"https://api.mistral.ai",
			"bearer",
			0,
			1,
			0,
		);
		insertProvider.run(
			"cohere",
			"Cohere",
			"https://api.cohere.ai",
			"bearer",
			0,
			1,
			0,
		);
		insertProvider.run(
			"deepseek",
			"DeepSeek",
			"https://api.deepseek.com",
			"bearer",
			0,
			1,
			0,
		);
		insertProvider.run(
			"opencode",
			"OpenCode Zen",
			"https://opencode.ai/zen/v1",
			"none",
			0,
			1,
			0,
		);
		insertProvider.run(
			"dahl",
			"Dahl Global",
			"https://inference.dahl.global/v1",
			"bearer",
			0,
			1,
			0,
		);

		const models: [string, string, number, number, number][] = [
			["gpt-4o", "openai", 128000, 1, 1],
			["gpt-4o", "groq", 128000, 1, 0],
			["gpt-4o", "openrouter", 128000, 1, 0],
			["claude-3-5-sonnet", "anthropic", 200000, 1, 1],
			["gemini-1.5-pro", "google", 1000000, 1, 1],
			["llama-3.1-8b", "groq", 131072, 1, 1],
			["mistral-large", "mistral", 128000, 1, 1],
			["big-pickle", "opencode", 200000, 1, 1],
			["deepseek-v4-flash-free", "opencode", 200000, 1, 0],
			["mimo-v2.5-free", "opencode", 131000, 1, 0],
			["ling-3.0-flash-free", "opencode", 200000, 1, 0],
			["ling-3.0-tiny-free", "opencode", 200000, 1, 0],
			["nemotron-3-ultra-free", "opencode", 1000000, 1, 0],
			["north-mini-code-free", "opencode", 131000, 1, 0],
			["laguna-s-2.1-free", "opencode", 200000, 1, 0],
			["longcat-2.0-free", "opencode", 200000, 1, 0],
			["moonshotai/Kimi-K2.6", "dahl", 200000, 1, 1],
			["MiniMaxAI/MiniMax-M2.7", "dahl", 200000, 1, 0],
		];
		for (const [name, provider, ctx, active, primary] of models) {
			insertModel.run(name, provider, ctx, active, primary);
		}
		exec("COMMIT");
	} catch (err) {
		exec("ROLLBACK");
		throw err;
	}

	const allowlistCount =
		(
			query("SELECT COUNT(*) AS c FROM model_allowlist").get() as
				| {
						c: number;
				  }
				| undefined
		)?.c ?? 0;
	if (allowlistCount === 0) {
		query(
			`INSERT INTO model_allowlist (model_name, action, reason)
       VALUES ('nonexistent-model', 'deny', 'sample denylist rule')`,
		).run();
	}

	query(
		`INSERT INTO compression_settings (id, rtk_enabled, caveman_enabled)
     VALUES (1, 0, 0)
     ON CONFLICT(id) DO NOTHING`,
	).run();

	query(
		`INSERT INTO load_balancing (model_name, strategy)
     VALUES ('gpt-4o', 'round_robin')
     ON CONFLICT(model_name) DO NOTHING`,
	).run();
}

export function ensureOpenCodeProvider() {
	query(
		`INSERT OR IGNORE INTO providers (id, name, base_url, auth_type, is_active, weight, priority)
     VALUES ('opencode', 'OpenCode Zen', 'https://opencode.ai/zen/v1', 'none', 0, 1, 0)`,
	).run();
	query(
		"UPDATE providers SET auth_type = 'none' WHERE id = 'opencode' AND auth_type != 'none'",
	).run();
	const opencodeModels: [string, number][] = [
		["big-pickle", 200000],
		["deepseek-v4-flash-free", 200000],
		["mimo-v2.5-free", 131000],
		["ling-3.0-flash-free", 200000],
		["ling-3.0-tiny-free", 200000],
		["nemotron-3-ultra-free", 1000000],
		["north-mini-code-free", 131000],
		["laguna-s-2.1-free", 200000],
		["longcat-2.0-free", 200000],
	];
	for (const [name, ctx] of opencodeModels) {
		query(
			`INSERT OR IGNORE INTO models (model_name, provider_id, context_length, is_active, is_primary)
       VALUES (?, 'opencode', ?, 1, CASE WHEN NOT EXISTS
         (SELECT 1 FROM models WHERE provider_id = 'opencode' AND is_primary = 1) THEN 1 ELSE 0 END)`,
		).run(name, ctx);
	}
	query(
		"UPDATE models SET is_active = 0 WHERE model_name = 'hy3-free' AND provider_id = 'opencode'",
	).run();
}

export function ensureDahlProvider() {
	query(
		`INSERT OR IGNORE INTO providers (id, name, base_url, auth_type, is_active, weight, priority)
     VALUES ('dahl', 'Dahl Global', 'https://inference.dahl.global/v1', 'bearer', 0, 1, 0)`,
	).run();
	query(
		"UPDATE providers SET auth_type = 'bearer' WHERE id = 'dahl' AND auth_type != 'bearer'",
	).run();
	const dahlModels: [string, number][] = [
		["moonshotai/Kimi-K2.6", 200000],
		["MiniMaxAI/MiniMax-M2.7", 200000],
	];
	for (const [name, ctx] of dahlModels) {
		query(
			`INSERT OR IGNORE INTO models (model_name, provider_id, context_length, is_active, is_primary)
       VALUES (?, 'dahl', ?, 1, CASE WHEN NOT EXISTS
         (SELECT 1 FROM models WHERE provider_id = 'dahl' AND is_primary = 1) THEN 1 ELSE 0 END)`,
		).run(name, ctx);
	}
}

if (!dbState.seeded) {
	seed();
	ensureOpenCodeProvider();
	ensureDahlProvider();
	dbState.seeded = true;
}
