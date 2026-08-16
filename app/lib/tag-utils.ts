import type { TagSuggestion } from "../.server/suggest";

export function parseChips(value: string): string[] {
	return value
		.split(/[\n,]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export function joinChips(chips: string[]): string {
	return chips.join(", ");
}

export function addChip(
	chips: string[],
	text: string,
): { chips: string[]; clear: boolean } {
	const clean = text.trim();
	if (!clean) return { chips, clear: false };
	const next = chips.includes(clean) ? chips : [...chips, clean];
	return { chips: next, clear: true };
}

export function removeChip(chips: string[], index: number): string[] {
	return chips.filter((_, i) => i !== index);
}

export function filterSuggestions(
	options: TagSuggestion[],
	chips: string[],
	query: string,
	limit = 20,
): TagSuggestion[] {
	const q = query.trim().toLowerCase();
	const existing = new Set(chips.map((c) => c.toLowerCase()));
	return options
		.filter((o) => !existing.has(o.value.toLowerCase()))
		.filter((o) => o.value.toLowerCase().includes(q))
		.slice(0, limit);
}
