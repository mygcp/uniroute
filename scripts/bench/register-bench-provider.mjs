// Pasang/hapus provider benchmark 'benchmock' di DB UniRoute.
//   node scripts/bench/register-bench-provider.mjs           → pasang
//   node scripts/bench/register-bench-provider.mjs --clean   → hapus
//
// Setelah memasang, RESTART server agar registry cache membacanya.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const dbPath = process.env.DATABASE_URL ?? "./data/uniroute.db";
const db = new DatabaseSync(path.resolve(dbPath));
const clean = process.argv.includes("--clean");

if (clean) {
	db.prepare("DELETE FROM models WHERE provider_id = 'benchmock'").run();
	db.prepare("DELETE FROM providers WHERE id = 'benchmock'").run();
	console.log("provider bench dihapus. Restart server untuk menyegarkan registry.");
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
		"provider bench terpasang (model: bench-test → http://127.0.0.1:8791).",
	);
	console.log("→ Restart server sekarang agar registry cache membacanya.");
}
db.close();
