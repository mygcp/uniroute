import { query } from "./db";
import { listApiKeys } from "./credential";
import { getRegistryEntry } from "~/registry";
import { reload } from "./registry";

/**
 * Manajemen model per provider — dipakai UI Provider dan MCP server.
 *
 * Registry routing (`registry.ts`) di-cache in-memory untuk jalur request
 * panas; SETIAP fungsi bermutasi di modul ini wajib memanggil `reload()`
 * agar perubahan lewat UI maupun MCP langsung terlihat tanpa reload
 * per-request di proxy-handler.
 */

function parseContextLength(value: FormDataEntryValue | null): number | null {
	if (value == null || value === "") return null;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return null;
	return Math.round(n);
}

/** Core upsert tanpa invalidasi registry — dipakai berulang oleh sync. */
function upsertProviderModelCore(
	providerId: string,
	modelName: string,
	contextLength: number | null,
	makePrimary = false,
): { id: number; created: boolean } {
	const existing = query(
		"SELECT id, is_primary FROM models WHERE model_name = ? AND provider_id = ?",
	).get(modelName, providerId) as { id: number; is_primary: number } | undefined;

	if (existing) {
		query(
			"UPDATE models SET context_length = COALESCE(?, context_length), is_active = 1 WHERE id = ?",
		).run(contextLength, existing.id);
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
	).get() as { ok: number } | undefined;

	const isPrimary = makePrimary || !hasPrimary ? 1 : 0;
	const result = query(
		`INSERT INTO models (model_name, provider_id, context_length, is_active, is_primary)
     VALUES (?, ?, ?, 1, ?)`,
	).run(modelName, providerId, contextLength, isPrimary) as {
		lastInsertRowid: number | bigint;
	};

	return { id: Number(result.lastInsertRowid), created: true };
}

/** Upsert satu model + invalidasi registry routing. */
export function upsertProviderModel(
	providerId: string,
	modelName: string,
	contextLength: number | null,
	makePrimary = false,
): { id: number; created: boolean } {
	const r = upsertProviderModelCore(
		providerId,
		modelName,
		contextLength,
		makePrimary,
	);
	reload();
	return r;
}

export async function fetchProviderModelsList(
	providerId: string,
): Promise<
	| { ok: true; models: { id: string; contextLength: number | null }[] }
	| { ok: false; message: string }
> {
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
		entry?.modelsUrl ?? new URL("/v1/models", provider.base_url).toString();

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
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 15000);
		const res = await fetch(modelsUrl, {
			headers,
			signal: controller.signal,
		});
		clearTimeout(timer);
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
}

/** Tarik daftar model dari upstream lalu upsert ke tabel models. */
export async function syncProviderModels(
	providerId: string,
): Promise<{ ok: boolean; added: number; message?: string }> {
	const fetched = await fetchProviderModelsList(providerId);
	if (!fetched.ok) return { ok: false, added: 0, message: fetched.message };

	let added = 0;
	fetched.models.forEach((m, i) => {
		const r = upsertProviderModelCore(providerId, m.id, m.contextLength, i === 0);
		if (r.created) added += 1;
	});
	// Satu invalidasi di akhir — bukan per model.
	reload();
	return { ok: true, added };
}
