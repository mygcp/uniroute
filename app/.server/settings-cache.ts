import { onDbReset, query } from "./db";

const SETTINGS_CACHE_SYMBOL = Symbol.for("uniroute.settingsCache");
const gSettings = globalThis as Record<symbol, Map<string, string | null> | undefined>;
const cache: Map<string, string | null> =
	gSettings[SETTINGS_CACHE_SYMBOL] ??
	(gSettings[SETTINGS_CACHE_SYMBOL] = new Map<string, string | null>());
onDbReset(() => cache.clear());

export function getCachedSetting(key: string): string | null {
	if (cache.has(key)) return cache.get(key) ?? null;
	const row = query("SELECT value FROM settings WHERE key = ?").get(key) as
		| { value: string | null }
		| undefined;
	const val = row?.value ?? null;
	cache.set(key, val);
	return val;
}

export function setCachedSetting(key: string, value: string): void {
	query(
		"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(key, value);
	cache.set(key, value);
}

export function deleteCachedSetting(key: string): void {
	query("DELETE FROM settings WHERE key = ?").run(key);
	cache.set(key, null);
}

export function invalidateSettingsCache(key?: string): void {
	if (key) {
		cache.delete(key);
	} else {
		cache.clear();
	}
}
