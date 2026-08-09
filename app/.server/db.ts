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

const dbPath = process.env.DATABASE_URL ?? "./data/uniroute.db";
mkdirSync(path.dirname(dbPath), { recursive: true });

const require = createRequire(import.meta.url);

let db: SqliteApi;

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

/**
 * Statement factory compatible with bun:sqlite (`.query`) and node:sqlite
 * (`.prepare`). Statement results are normalized to `Record<string, unknown>[]`.
 */
export function query(sql: string): StatementApi {
  const q = (db as { query?: (sql: string) => unknown }).query;
  if (typeof q === "function") {
    return q.call(db, sql) as StatementApi;
  }
  const prepare = (db as { prepare?: (sql: string) => unknown }).prepare;
  if (typeof prepare === "function") {
    return prepare.call(db, sql) as StatementApi;
  }
  throw new Error("sqlite API not available");
}

export const exec = (sql: string): void => db.exec(sql);

/** Tutup koneksi SQLite — dipanggil saat graceful shutdown. */
export function closeDb(): void {
  try {
    db.close();
  } catch {
    /* already closed */
  }
}

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
  created_at INTEGER DEFAULT (unixepoch())
);`);

db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);`);

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