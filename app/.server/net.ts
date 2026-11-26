const MASK32 = 0xffffffff;
const MASK128 = (1n << 128n) - 1n;

export function parseIpv4(ip: string): number | null {
	const cleaned = ip.trim();
	const parts = cleaned.split(".");
	if (parts.length !== 4) return null;

	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		value = ((value << 8) | octet) >>> 0;
	}
	return value >>> 0;
}

export function normalizeIpString(raw: string): string {
	let ip = stripHostDecorations(raw);
	const lower = ip.toLowerCase();
	if (lower.startsWith("::ffff:")) {
		const tail = ip.slice(7);
		if (parseIpv4(tail) !== null) return tail;
	}
	if (lower.includes(":")) {
		const v6 = parseIpv6Raw(ip);
		if (v6 !== null && (v6 >> 32n) === 0xffffn) {
			const v4 = Number(v6 & 0xffff_ffffn);
			return `${(v4 >>> 24) & 0xff}.${(v4 >>> 16) & 0xff}.${(v4 >>> 8) & 0xff}.${v4 & 0xff}`;
		}
	}
	return ip;
}

function stripHostDecorations(raw: string): string {
	let ip = raw.trim();
	if (ip.startsWith("[") && ip.endsWith("]")) {
		ip = ip.slice(1, -1);
	}
	const zoneIdx = ip.indexOf("%");
	if (zoneIdx !== -1) {
		ip = ip.slice(0, zoneIdx);
	}
	return ip;
}

function parseIpv6Raw(ip: string): bigint | null {
	let s = stripHostDecorations(ip).toLowerCase();
	if (!s.includes(":")) return null;

	const lastColon = s.lastIndexOf(":");
	const tail = s.slice(lastColon + 1);
	if (tail.includes(".")) {
		const v4 = parseIpv4(tail);
		if (v4 === null) return null;
		const hi = ((v4 >>> 16) & 0xffff).toString(16);
		const lo = (v4 & 0xffff).toString(16);
		s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
	}

	const doubleColonParts = s.split("::");
	if (doubleColonParts.length > 2) return null;

	let groups: string[];
	if (doubleColonParts.length === 2) {
		const left = doubleColonParts[0] ? doubleColonParts[0].split(":") : [];
		const right = doubleColonParts[1] ? doubleColonParts[1].split(":") : [];
		const missing = 8 - (left.length + right.length);
		if (missing < 1) return null;
		groups = [...left, ...Array<string>(missing).fill("0"), ...right];
	} else {
		groups = s.split(":");
	}

	if (groups.length !== 8) return null;

	let result = 0n;
	for (const g of groups) {
		if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
		result = (result << 16n) | BigInt(parseInt(g, 16));
	}
	return result;
}

export function parseIpv6(ip: string): bigint | null {
	return parseIpv6Raw(ip);
}

type ParsedCidr =
	| { family: 4; ip: number; mask: number }
	| { family: 6; ip: bigint; mask: bigint };

function parseCidr(cidr: string): ParsedCidr | null {
	const trimmed = cidr.trim();
	if (!trimmed) return null;

	const slash = trimmed.indexOf("/");
	const ipRaw = slash === -1 ? trimmed : trimmed.slice(0, slash);
	const ipNorm = normalizeIpString(ipRaw);

	const v4 = parseIpv4(ipNorm);
	if (v4 !== null) {
		let prefix = 32;
		if (slash !== -1) {
			const p = trimmed.slice(slash + 1);
			if (!/^\d+$/.test(p)) return null;
			prefix = Number(p);
			if (prefix < 0 || prefix > 32) return null;
		}
		const mask = prefix === 0 ? 0 : (MASK32 << (32 - prefix)) >>> 0;
		return { family: 4, ip: (v4 & mask) >>> 0, mask };
	}

	const v6 = parseIpv6(ipNorm);
	if (v6 !== null) {
		let prefix = 128;
		if (slash !== -1) {
			const p = trimmed.slice(slash + 1);
			if (!/^\d+$/.test(p)) return null;
			prefix = Number(p);
			if (prefix < 0 || prefix > 128) return null;
		}
		const mask =
			prefix === 0 ? 0n : ((MASK128 << BigInt(128 - prefix)) & MASK128);
		return { family: 6, ip: v6 & mask, mask };
	}

	return null;
}

export function ipInCidr(ip: string, cidr: string): boolean {
	const norm = normalizeIpString(ip);
	const parsed = parseCidr(cidr);
	if (!parsed) return false;

	if (parsed.family === 4) {
		const v4 = parseIpv4(norm);
		if (v4 === null) return false;
		return ((v4 & parsed.mask) >>> 0) === parsed.ip;
	}

	const v6 = parseIpv6(norm);
	if (v6 === null) return false;
	return (v6 & parsed.mask) === parsed.ip;
}

export function ipInList(ip: string, list: string[]): boolean {
	for (const entry of list) {
		if (ipInCidr(ip, entry)) return true;
	}
	return false;
}
