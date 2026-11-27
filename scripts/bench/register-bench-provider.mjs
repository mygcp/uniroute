// Register or remove the 'benchmock' provider in UniRoute's SQLite DB.
//   node scripts/bench/register-bench-provider.mjs           (register)
//   node scripts/bench/register-bench-provider.mjs --clean   (remove)
//
// Restart the server afterward so the registry cache reloads it.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const dbPath = process.env.DATABASE_URL ?? "./data/uniroute.db";
const db = new DatabaseSync(path.resolve(dbPath));
const clean = process.argv.includes("--clean");

if (clean) {
	db.prepare("DELETE FROM models WHERE provider_id = 'benchmock'").run();
	db.prepare("DELETE FROM providers WHERE id = 'benchmock'").run();
	console.log("bench provider removed. Restart the server to refresh the registry.");
} else {
	db.prepare(
		`INSERT OR REPLACE INTO providers (id, name, base_url, auth_type, is_active, weight, priority)
		 VALUES ('benchmock', 'Bench Mock', 'http://127.0.0.1:8791', 'none', 1, 1, 0)`,
	).run();
	db.prepare(
		`INSERT OR REPLACE INTO models (model_name, provider_id, context_length, is_active, is_primary)
		 VALUES ('bench-test', 'benchmock', 8192, 1, 1)`,
	).run();
	console.log(
		"bench provider registered (model: bench-test -> http://127.0.0.1:8791).",
	);
	console.log("Restart the server now so the registry cache picks it up.");
}
db.close();
