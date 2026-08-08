import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const dbPath = process.env.DATABASE_URL ?? "./data/uniroute.db";
mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

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

export function seed() {
  const count = (
    db.prepare("SELECT COUNT(*) AS c FROM providers").get() as { c: number }
  )?.c ?? 0;
  if (count > 0) return;

  const insertProvider = db.prepare(
    `INSERT INTO providers (id, name, base_url, auth_type, is_active, weight, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertModel = db.prepare(
    `INSERT INTO models (model_name, provider_id, context_length, is_active, is_primary)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  db.exec("BEGIN");
  try {
    insertProvider.run(
      "openai",
      "OpenAI",
      "https://api.openai.com",
      "bearer",
      1,
      3,
      2,
    );
    insertProvider.run(
      "anthropic",
      "Anthropic",
      "https://api.anthropic.com",
      "bearer",
      1,
      1,
      1,
    );
    insertProvider.run(
      "google",
      "Google",
      "https://generativelanguage.googleapis.com",
      "apikey",
      1,
      1,
      0,
    );
    insertProvider.run("groq", "Groq", "https://api.groq.com", "bearer", 1, 1, 1);
    insertProvider.run(
      "openrouter",
      "OpenRouter",
      "https://openrouter.ai",
      "bearer",
      1,
      2,
      0,
    );
    insertProvider.run(
      "mistral",
      "Mistral",
      "https://api.mistral.ai",
      "bearer",
      1,
      1,
      0,
    );
    insertProvider.run(
      "cohere",
      "Cohere",
      "https://api.cohere.ai",
      "bearer",
      1,
      1,
      0,
    );
    insertProvider.run(
      "deepseek",
      "DeepSeek",
      "https://api.deepseek.com",
      "bearer",
      1,
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
    db.prepare("SELECT COUNT(*) AS c FROM model_allowlist").get() as { c: number }
  )?.c ?? 0;
  if (allowlistCount === 0) {
    db.prepare(
      `INSERT INTO model_allowlist (model_name, action, reason)
       VALUES ('nonexistent-model', 'deny', 'seed denylist contoh')`,
    ).run();
  }

  db.prepare(
    `INSERT INTO compression_settings (id, rtk_enabled, caveman_enabled)
     VALUES (1, 1, 0)
     ON CONFLICT(id) DO NOTHING`,
  ).run();

  db.prepare(
    `INSERT INTO load_balancing (model_name, strategy)
     VALUES ('gpt-4o', 'round_robin')
     ON CONFLICT(model_name) DO NOTHING`,
  ).run();
}

seed();