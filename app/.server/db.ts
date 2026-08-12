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

let db!: SqliteApi;
let opened = false;

function openDb(): void {
  const dbPath = process.env.DATABASE_URL ?? "./data/uniroute.db";
  mkdirSync(path.dirname(dbPath), { recursive: true });
  try {
    // Bun runtime
    const { Database } = require("bun:sqlite") as {
      Database: new (p: string, opts: { create: boolean }) => SqliteApi;
    };
    db = new Database(dbPath, { create: true });
  } catch {
    // Node runtime (dev server / vite SSR)
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (p: string) => SqliteApi;
    };
    db = new DatabaseSync(dbPath);
  }
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  opened = true;
  try {
    initSchema();
  } catch (err) {
    opened = false;
    throw err;
  }
}

function ensureDb(): SqliteApi {
  if (!opened) {
    openDb();
  }
  return db;
}

/**
 * Statement factory compatible with bun:sqlite (`.query`) and node:sqlite
 * (`.prepare`). Statement results are normalized to `Record<string, unknown>[]`.
 */
export function query(sql: string): StatementApi {
  const conn = ensureDb();
  const q = (conn as { query?: (sql: string) => unknown }).query;
  if (typeof q === "function") {
    return q.call(conn, sql) as StatementApi;
  }
  const prepare = (conn as { prepare?: (sql: string) => unknown }).prepare;
  if (typeof prepare === "function") {
    return prepare.call(conn, sql) as StatementApi;
  }
  throw new Error("sqlite API not available");
}

export const exec = (sql: string): void => ensureDb().exec(sql);

/** Tutup koneksi SQLite — dipanggil saat graceful shutdown. */
export function closeDb(): void {
  try {
    if (opened) db.close();
  } catch {
    /* already closed */
  }
  opened = false;
}

/** Re-open the connection from the current DATABASE_URL on next use. */
export function resetDb(): void {
  closeDb();
}

/** Idempotent ALTER TABLE: tambah kolom hanya bila belum ada (migrasi DB lama). */
function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = (
    query(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`);
  }
}

function initSchema(): void {
db.exec(`CREATE TABLE IF NOT EXISTS providers (
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

db.exec(`CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  context_length INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_primary INTEGER NOT NULL DEFAULT 0,
  UNIQUE(model_name, provider_id)
);`);

db.exec(`CREATE TABLE IF NOT EXISTS model_allowlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'allow',
  reason TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(model_name, action)
);`);

db.exec(`CREATE TABLE IF NOT EXISTS routing_rules (
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

db.exec(`CREATE TABLE IF NOT EXISTS load_balancing (
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

db.exec(`CREATE TABLE IF NOT EXISTS compression_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rtk_enabled INTEGER NOT NULL DEFAULT 0,
  caveman_enabled INTEGER NOT NULL DEFAULT 0,
  rtk_binary_path TEXT DEFAULT './bin/rtk',
  caveman_binary_path TEXT DEFAULT './bin/caveman',
  updated_at INTEGER DEFAULT (unixepoch())
);`);

db.exec(`CREATE TABLE IF NOT EXISTS request_logs (
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

db.exec(`CREATE TABLE IF NOT EXISTS proxy_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);`);

db.exec(`CREATE TABLE IF NOT EXISTS provider_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  label TEXT,
  api_key TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_routing INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);`);

db.exec(`CREATE TABLE IF NOT EXISTS client_api_keys (
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

db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);`);

// Migrasi DB lama: tambah kolom API Manager bila tabel sudah ada tanpa kolom baru.
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

db.exec(`CREATE TABLE IF NOT EXISTS key_usage_daily (
  key_id INTEGER NOT NULL REFERENCES client_api_keys(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, date)
);`);

db.exec(`CREATE TABLE IF NOT EXISTS key_audit_logs (
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

db.exec(`CREATE TABLE IF NOT EXISTS model_pricing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  input_per_mtok REAL NOT NULL DEFAULT 0,
  output_per_mtok REAL NOT NULL DEFAULT 0,
  updated_at INTEGER DEFAULT (unixepoch()),
  UNIQUE (model, provider_id)
);`);

db.exec(`CREATE TABLE IF NOT EXISTS key_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  config TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);`);

db.exec(`CREATE TABLE IF NOT EXISTS key_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  shared_quota TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);`);

db.exec(`CREATE TABLE IF NOT EXISTS key_group_members (
  group_id INTEGER NOT NULL REFERENCES key_groups(id) ON DELETE CASCADE,
  key_id INTEGER NOT NULL REFERENCES client_api_keys(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, key_id)
);`);

db.exec(`CREATE TABLE IF NOT EXISTS webhook_events (
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

db.exec(`CREATE TABLE IF NOT EXISTS combos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  strategy TEXT NOT NULL DEFAULT 'priority',
  config TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);`);
db.exec(`CREATE TABLE IF NOT EXISTS combo_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  combo_id INTEGER NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  provider_id TEXT,
  model_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  prompt TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);`);
db.exec(`CREATE TABLE IF NOT EXISTS combo_metrics (
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

// Migrate legacy single-key table (provider_id PRIMARY KEY) to multi-key schema.
{
  const cols = (
    query("PRAGMA table_info(provider_credentials)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  if (cols.length > 0 && !cols.includes("id")) {
    db.exec("ALTER TABLE provider_credentials RENAME TO provider_credentials_legacy;");
    db.exec(`CREATE TABLE provider_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT NOT NULL,
      label TEXT,
      api_key TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_routing INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );`);
    db.exec(`INSERT INTO provider_credentials (provider_id, api_key, is_routing, updated_at)
             SELECT provider_id, api_key, 1, updated_at FROM provider_credentials_legacy;`);
    db.exec("DROP TABLE provider_credentials_legacy;");
  }
}

{
  const modelCols = (
    query("PRAGMA table_info(models)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  if (modelCols.length > 0 && !modelCols.includes("is_public")) {
    db.exec("ALTER TABLE models ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0");
  }
}
}

export function seed() {
  const count = (
    query("SELECT COUNT(*) AS c FROM providers").get() as {
      c: number;
    } | undefined
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

  db.exec("BEGIN");
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
    insertProvider.run("groq", "Groq", "https://api.groq.com", "bearer", 0, 1, 1);
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
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const allowlistCount = (
    query("SELECT COUNT(*) AS c FROM model_allowlist").get() as {
      c: number;
    } | undefined
  )?.c ?? 0;
  if (allowlistCount === 0) {
    query(
      `INSERT INTO model_allowlist (model_name, action, reason)
       VALUES ('nonexistent-model', 'deny', 'seed denylist contoh')`,
    ).run();
  }

  query(
    `INSERT INTO compression_settings (id, rtk_enabled, caveman_enabled)
     VALUES (1, 1, 0)
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

seed();

ensureOpenCodeProvider();

ensureDahlProvider();