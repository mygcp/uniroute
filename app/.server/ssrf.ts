import { lookup } from "node:dns/promises";
import { normalizeIpString, parseIpv4, parseIpv6 } from "./net";

export type IpClass = "public" | "loopback" | "private" | "metadata" | "invalid";

const METADATA_HOSTS = new Set([
	"metadata.google.internal",
	"metadata",
	"169.254.169.254",
	"100.100.100.200",
	"fd00:ec2::254",
]);

export function isMetadataHost(hostname: string): boolean {
	const h = normalizeIpString(hostname).toLowerCase().replace(/\.$/, "");
	return METADATA_HOSTS.has(h);
}

export function isLoopbackHost(hostname: string): boolean {
	const h = normalizeIpString(hostname).toLowerCase().replace(/\.$/, "");
	if (h === "localhost" || h.endsWith(".localhost")) return true;
	return classifyIp(h) === "loopback";
}

export function classifyIp(rawIp: string): IpClass {
	const ip = normalizeIpString(rawIp);
	const v4 = parseIpv4(ip);
	if (v4 !== null) {
		const a = (v4 >>> 24) & 0xff;
		const b = (v4 >>> 16) & 0xff;
		if (a === 169 && b === 254) return "metadata";
		if (v4 === 0x646464c8) return "metadata"; // 100.100.100.200
		if (a === 127) return "loopback";
		if (a === 0) return "private";
		if (a === 10) return "private";
		if (a === 172 && b >= 16 && b <= 31) return "private";
		if (a === 192 && b === 168) return "private";
		if (a === 100 && b >= 64 && b <= 127) return "private";
		if (a === 192 && b === 0 && ((v4 >>> 8) & 0xff) === 0) return "private";
		if (a >= 224) return "private";
		return "public";
	}

	const v6 = parseIpv6(ip);
	if (v6 !== null) {
		if (v6 === 1n) return "loopback"; // ::1
		if (v6 === 0n) return "private"; // ::
		if (v6 === 0xfd00_0ec2_0000_0000_0000_0000_0000_0254n) return "metadata";
		const top16 = Number((v6 >> 112n) & 0xffffn);
		if ((top16 & 0xffc0) === 0xfe80) return "metadata"; // fe80::/10 link-local
		if ((top16 & 0xfe00) === 0xfc00) return "private"; // fc00::/7 ULA
		if ((top16 & 0xff00) === 0xff00) return "private"; // ff00::/8 multicast
		return "public";
	}

	return "invalid";
}

export type UrlPolicyOptions = {
	allowPrivate?: boolean;
	allowLoopback?: boolean;
	skipDns?: boolean;
};

export type UrlValidationResult =
	| { ok: true; url: URL }
	| { ok: false; reason: string };

function isIpAllowed(ipClass: IpClass, opts: UrlPolicyOptions): boolean {
	if (ipClass === "public") return true;
	if (ipClass === "metadata") return false;
	if (ipClass === "loopback") {
		return Boolean(opts.allowLoopback || opts.allowPrivate || process.env.UNIROUTE_ALLOW_PRIVATE_URLS === "1");
	}
	if (ipClass === "private") {
		return Boolean(opts.allowPrivate || process.env.UNIROUTE_ALLOW_PRIVATE_URLS === "1");
	}
	return false;
}

export function validateUrlSync(
	rawUrl: string,
	opts: UrlPolicyOptions = {},
): UrlValidationResult {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl.trim());
	} catch {
		return { ok: false, reason: "invalid URL" };
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, reason: "unsupported URL protocol" };
	}
	if (!parsed.hostname) {
		return { ok: false, reason: "missing URL host" };
	}
	if (isMetadataHost(parsed.hostname)) {
		return { ok: false, reason: "blocked metadata host" };
	}

	const normHost = normalizeIpString(parsed.hostname).toLowerCase().replace(/\.$/, "");
	if (normHost === "localhost" || normHost.endsWith(".localhost")) {
		if (!isIpAllowed("loopback", opts)) {
			return { ok: false, reason: "loopback host not allowed" };
		}
		return { ok: true, url: parsed };
	}

	const ipClass = classifyIp(normHost);
	if (ipClass !== "invalid") {
		if (!isIpAllowed(ipClass, opts)) {
			return { ok: false, reason: `${ipClass} address not allowed` };
		}
	}

	return { ok: true, url: parsed };
}

export async function assertSafeUrl(
	rawUrl: string,
	opts: UrlPolicyOptions = {},
): Promise<URL> {
	const syncResult = validateUrlSync(rawUrl, opts);
	if (!syncResult.ok) {
		throw new Error(syncResult.reason);
	}
	const { url } = syncResult;
	const normHost = normalizeIpString(url.hostname).replace(/\.$/, "");

	if (opts.skipDns || classifyIp(normHost) !== "invalid" || isLoopbackHost(normHost)) {
		return url;
	}

	let addrs: Array<{ address: string; family: number }>;
	try {
		addrs = await lookup(normHost, { all: true });
	} catch {
		if (opts.allowPrivate || process.env.UNIROUTE_ALLOW_PRIVATE_URLS === "1") {
			return url;
		}
		throw new Error("DNS resolution failed");
	}

	if (addrs.length === 0) {
		throw new Error("host did not resolve");
	}

	for (const entry of addrs) {
		const cls = classifyIp(entry.address);
		if (!isIpAllowed(cls, opts)) {
			throw new Error(`resolved ${cls} address not allowed`);
		}
	}

	return url;
}
