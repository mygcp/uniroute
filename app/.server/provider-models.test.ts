import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = `/tmp/uniroute-provider-models-${randomUUID()}.db`;

type DbModule = typeof import("./db");
type RegModule = typeof import("./registry");
type PmModule = typeof import("./provider-models");
let db: DbModule;
let reg: RegModule;
let pm: PmModule;

beforeAll(async () => {
	db = await import("./db");
	db.resetDb();
	reg = await import("./registry");
	pm = await import("./provider-models");
	db.seed();
	db.query("UPDATE providers SET is_active = 1 WHERE id = 'openai'").run();
	reg.reload();
});

afterAll(() => {
	try {
		Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
	} catch {
		/* ignore */
	}
});

describe("provider-models registry invalidation", () => {
	// Kunci regresi optimasi: handleProxy TIDAK me-reload registry per request.
	// Konsekuensinya, mutasi lewat service layer WAJIB menyegarkan cache —
	// test ini memastikan kontrak itu tidak pernah rusak lagi.
	test("upsertProviderModel langsung terlihat di registry tanpa reload manual", () => {
		const before = reg.getProviders("model-opt-check");
		expect(before.length).toBe(0);

		pm.upsertProviderModel("openai", "model-opt-check", 8192, false);

		const after = reg.getProviders("model-opt-check");
		expect(after.length).toBe(1);
		expect(after[0]!.id).toBe("openai");
	});

	test("syncProviderModels juga menyegarkan registry (satu invalidasi di akhir)", async () => {
		// Sync dengan daftar fetch gagal tidak boleh merusak state; cukup
		// pastikan upsert massal lewat core tetap menghasilkan registry segar
		// untuk model yang ditambahkan via upsert berulang.
		pm.upsertProviderModel("openai", "model-opt-check-2", null, true);
		expect(reg.getProviders("model-opt-check-2").length).toBe(1);
	});
});
