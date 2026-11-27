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
	// Service-layer mutations must refresh the in-memory registry cache.
	test("upsertProviderModel is immediately visible in registry without manual reload", () => {
		const before = reg.getProviders("model-opt-check");
		expect(before.length).toBe(0);

		pm.upsertProviderModel("openai", "model-opt-check", 8192, false);

		const after = reg.getProviders("model-opt-check");
		expect(after.length).toBe(1);
		expect(after[0]!.id).toBe("openai");
	});

	test("syncProviderModels refreshes registry with a single invalidation", async () => {
		pm.upsertProviderModel("openai", "model-opt-check-2", null, true);
		expect(reg.getProviders("model-opt-check-2").length).toBe(1);
	});
});
