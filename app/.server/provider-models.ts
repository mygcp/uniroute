import { singleflight } from "./async-utils";
import { exec, query } from "./db";
import { listApiKeys } from "./credential";
import { getRegistryEntry } from "~/registry";
import { reload } from "./registry";
import { joinApiUrl } from "./adapter";
import { assertSafeUrl } from "./ssrf";

function upsertProviderModelCore(
	providerId: string,
	modelName: string,
	contextLength: number | null,
	makePrimary = false,
	displayNameOverride?: string | null,
): { id: number; created: boolean } {
	const existing = query(
		"SELECT id, is_primary FROM models WHERE model_name = ? AND provider_id = ?",
	).get(modelName, providerId) as { id: number; is_primary: number } | undefined;

	const cleanDisplay = (displayNameOverride ?? "").trim() || null;

	if (existing) {
		query(
			"UPDATE models SET context_length = COALESCE(?, context_length), is_active = 1 WHERE id = ?",
		).run(contextLength, existing.id);
		if (cleanDisplay !== null) {
			try {
				query("UPDATE models SET display_name = ? WHERE id = ?").run(
					cleanDisplay,
					existing.id,
				);
			} catch {
				/* ignore */
			}
		}
		if (makePrimary) {
			query("UPDATE models SET is_primary = 0 WHERE provider_id = ?").run(providerId);
			query("UPDATE models SET is_primary = 1 WHERE id = ?").run(existing.id);
		}
		return { id: existing.id, created: false };
	}

	if (makePrimary) {
		query("UPDATE models SET is_primary = 0 WHERE provider_id = ?").run(providerId);
	}

	const hasPrimary = query(
		"SELECT 1 AS ok FROM models WHERE provider_id = ? AND is_primary = 1",
	).get(providerId) as { ok: number } | undefined;

	const isPrimary = makePrimary || !hasPrimary ? 1 : 0;
	let newId: number;
	try {
		const result = query(
			`INSERT INTO models (model_name, provider_id, context_length, is_active, is_primary, display_name)
     VALUES (?, ?, ?, 1, ?, ?)`,
		).run(modelName, providerId, contextLength, isPrimary, cleanDisplay) as {
			lastInsertRowid: number | bigint;
		};
		newId = Number(result.lastInsertRowid);
	} catch {
		const result = query(
			`INSERT INTO models (model_name, provider_id, context_length, is_active, is_primary)
     VALUES (?, ?, ?, 1, ?)`,
		).run(modelName, providerId, contextLength, isPrimary) as {
			lastInsertRowid: number | bigint;
		};
		newId = Number(result.lastInsertRowid);
		if (cleanDisplay) {
			try {
				query("UPDATE models SET display_name = ? WHERE id = ?").run(
					cleanDisplay,
					newId,
				);
			} catch {
				/* ignore */
			}
		}
	}

	return { id: newId, created: true };
}

export function upsertProviderModel(
	providerId: string,
	modelName: string,
	contextLength: number | null,
	makePrimary = false,
	displayNameOverride?: string | null,
): { id: number; created: boolean } {
	const r = upsertProviderModelCore(
		providerId,
		modelName,
		contextLength,
		makePrimary,
		displayNameOverride,
	);
	reload();
	return r;
}

export function upsertProviderModelsBatch(
	providerId: string,
	items: Array<{ modelName: string; contextLength: number | null; makePrimary?: boolean }>,
): { created: number; updated: number } {
	let created = 0;
	let updated = 0;
	exec("BEGIN");
	try {
		for (const item of items) {
			const res = upsertProviderModelCore(
				providerId,
				item.modelName,
				item.contextLength,
				item.makePrimary ?? false,
			);
			if (res.created) created += 1;
			else updated += 1;
		}
		exec("COMMIT");
	} catch (err) {
		exec("ROLLBACK");
		throw err;
	}
	reload();
	return { created, updated };
}

export function fetchProviderModelsList(
	providerId: string,
): Promise<
	| { ok: true; models: { id: string; contextLength: number | null }[] }
	| { ok: false; message: string }
> {
	return singleflight(`provider-models:${providerId}`, async () => {
		const provider = query(
			"SELECT base_url, auth_type FROM providers WHERE id = ?",
		).get(providerId) as { base_url: string; auth_type: string } | undefined;
		if (!provider) return { ok: false, message: "Provider not found" };

		const keys = listApiKeys(providerId).filter((k) => k.is_active);
		const key = keys.find((k) => k.is_routing) ?? keys[0];
		if (!key && provider.auth_type !== "none") {
			return { ok: false, message: "No active API key to import models" };
		}

		const entry = getRegistryEntry(providerId);
		const modelsUrl =
			entry?.modelsUrl ?? joinApiUrl(provider.base_url, "/v1/models");

		try {
			await assertSafeUrl(modelsUrl, { allowPrivate: true, allowLoopback: true });
		} catch (err) {
			return {
				ok: false,
				message: err instanceof Error ? err.message : "Invalid provider URL",
			};
		}

		const headers = new Headers({ "Content-Type": "application/json" });
		if (key) {
			if (provider.auth_type === "bearer") {
				headers.set("Authorization", `Bearer ${key.api_key}`);
			} else if (provider.auth_type === "apikey") {
				headers.set("x-goog-api-key", key.api_key);
			}
		}
		if (entry?.headers) {
			for (const [k, v] of Object.entries(entry.headers)) headers.set(k, v);
		}

		try {
			const res = await fetch(modelsUrl, {
				headers,
				redirect: "manual",
				signal: AbortSignal.timeout(15_000),
			});
			if (!res.ok) {
				const text = (await res.text()).slice(0, 300);
				return { ok: false, message: `HTTP ${res.status}: ${text}` };
			}
			type RemoteModelItem = {
				id?: string;
				name?: string;
				context_length?: number;
				contextLength?: number;
				max_model_len?: number;
			};
			const body = (await res.json()) as {
				data?: RemoteModelItem[];
				models?: RemoteModelItem[];
			};
			const raw: RemoteModelItem[] = Array.isArray(body?.data)
				? body.data
				: Array.isArray(body?.models)
					? body.models
					: Array.isArray(body)
						? (body as RemoteModelItem[])
						: [];
			const models = raw
				.map((m) => {
					const id = String(m.id ?? m.name ?? "").trim();
					if (!id) return null;
					const contextLength =
						typeof m.context_length === "number"
							? Math.round(m.context_length)
							: typeof m.contextLength === "number"
								? Math.round(m.contextLength)
								: typeof m.max_model_len === "number"
									? Math.round(m.max_model_len)
									: null;
					return { id, contextLength };
				})
				.filter((m): m is { id: string; contextLength: number | null } => m !== null);

			return { ok: true, models };
		} catch (err) {
			return {
				ok: false,
				message: err instanceof Error ? err.message : String(err),
			};
		}
	});
}

export async function syncProviderModels(
	providerId: string,
): Promise<{ ok: boolean; added: number; message?: string }> {
	const fetched = await fetchProviderModelsList(providerId);
	if (!fetched.ok) return { ok: false, added: 0, message: fetched.message };

	const res = upsertProviderModelsBatch(
		providerId,
		fetched.models.map((m, i) => ({
			modelName: m.id,
			contextLength: m.contextLength,
			makePrimary: i === 0,
		})),
	);
	return { ok: true, added: res.created };
}
