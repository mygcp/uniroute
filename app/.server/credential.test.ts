import "./test-env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resetTestDb } from "./test-db";
import {
	addApiKey,
	getApiKeyRow,
	listApiKeys,
	setApiKeyProxyPool,
	setRoutingKey,
} from "./credential";

describe("provider credential proxy pool", () => {
	beforeAll(() => resetTestDb());
	afterAll(() => resetTestDb());

	const providerId = () => `cred-test-${randomUUID()}`;

	test("setApiKeyProxyPool persists per key; getApiKeyRow follows routing", () => {
		const pid = providerId();
		addApiKey(pid, "sk-a", "A", true);
		addApiKey(pid, "sk-b", "B", false);
		const a = listApiKeys(pid).find((k) => k.api_key === "sk-a")!;
		const b = listApiKeys(pid).find((k) => k.api_key === "sk-b")!;

		expect(a.proxy_pool_id).toBeNull();

		setApiKeyProxyPool(a.id, 42);
		expect(listApiKeys(pid).find((k) => k.id === a.id)?.proxy_pool_id).toBe(42);

		setRoutingKey(b.id);
		expect(getApiKeyRow(pid)?.id).toBe(b.id);
		expect(getApiKeyRow(pid)?.proxy_pool_id).toBeNull();

		setApiKeyProxyPool(b.id, 7);
		expect(getApiKeyRow(pid)?.proxy_pool_id).toBe(7);

		setApiKeyProxyPool(a.id, null);
		expect(listApiKeys(pid).find((k) => k.id === a.id)?.proxy_pool_id).toBeNull();
		expect(getApiKeyRow(pid)?.proxy_pool_id).toBe(7);
	});
});