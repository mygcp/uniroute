import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	constants as fsConstants,
	unlinkSync,
	writeFileSync,
	accessSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { query } from "./db";

/**
 * Konfigurasi harness AI agent CLI (Codex, Claude Code, OpenCode) agar
 * terhubung ke gateway UniRoute.
 *
 * Safety: setiap penulisan config otomatis mem-backup file lama ke
 * `~/.uniroute/backups/<harness>/` dan bisa di-restore kapan saja. File JSON
 * yang tidak valid tidak akan ditimpa (abort + pesan agar di-restore manual).
 */

export type HarnessId = "codex" | "claude-code" | "opencode";

export type HarnessMeta = {
	id: HarnessId;
	name: string;
	description: string;
	/** Path config relatif terhadap home (atau XDG_CONFIG_HOME untuk opencode). */
	configPath: string;
	format: "toml" | "json";
	docsUrl: string;
};

export const HARNESS_IDS: HarnessId[] = ["codex", "claude-code", "opencode"];

export const HARNESS_REGISTRY: Record<HarnessId, HarnessMeta> = {
	codex: {
		id: "codex",
		name: "OpenAI Codex CLI",
		description:
			"Menambah provider 'uniroute' di ~/.codex/config.toml dan mengarahkan model_provider ke UniRoute.",
		configPath: ".codex/config.toml",
		format: "toml",
		docsUrl: "https://developers.openai.com/codex/config-reference",
	},
	"claude-code": {
		id: "claude-code",
		name: "Claude Code",
		description:
			"Set ANTHROPIC_BASE_URL & ANTHROPIC_AUTH_TOKEN di ~/.claude/settings.json tanpa menghapus key lain.",
		configPath: path.join(".claude", "settings.json"),
		format: "json",
		docsUrl: "https://code.claude.com/docs/en/settings",
	},
	opencode: {
		id: "opencode",
		name: "OpenCode",
		description:
			"Menambah custom provider 'uniroute' di ~/.config/opencode/opencode.json (hormati XDG_CONFIG_HOME).",
		configPath: path.join(".config", "opencode", "opencode.json"),
		format: "json",
		docsUrl: "https://opencode.ai/v2/docs/providers",
	},
};

export function isHarnessId(value: string): value is HarnessId {
	return (HARNESS_IDS as string[]).includes(value);
}

export class ConfigError extends Error {}

export type GenerateInput = {
	/** Base URL gateway, mis. http://192.168.1.10:3000 (tanpa /v1). */
	baseUrl: string;
	/** API key client UniRoute dalam bentuk plaintext. */
	apiKey: string;
	/** Model default (opsional). */
	model?: string | null;
	/** Codex saja: token langsung di file ("token") atau via env var ("env"). */
	authMode?: "token" | "env";
};

const UNIROUTE_ENV_KEY = "UNIROUTE_API_KEY";
const CODEX_SECTION_HEADER = "[model_providers.uniroute]";
const BACKUP_SUFFIX = ".bak";
/* ---------------------------------- paths --------------------------------- */

function baseDir(home?: string): string {
	return home ?? process.env.UNIROUTE_AGENT_HOME ?? homedir();
}

function xdgConfigDir(home?: string): string {
	if (home) return path.join(home, ".config");
	const xdg = process.env.XDG_CONFIG_HOME;
	if (xdg && path.isAbsolute(xdg)) return xdg;
	return path.join(baseDir(home), ".config");
}

function resolveConfigAbsPath(id: HarnessId, home?: string): string {
	const meta = HARNESS_REGISTRY[id];
	if (id === "opencode") {
		return path.join(xdgConfigDir(home), "opencode", "opencode.json");
	}
	return path.join(baseDir(home), meta.configPath);
}

function backupDir(id: HarnessId, home?: string): string {
	return path.join(baseDir(home), ".uniroute", "backups", id);
}

/* ------------------------------ value escaping ---------------------------- */

function tomlEscape(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function jsonClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function parseJsonMeta(raw: string): Record<string, unknown> | null {
	try {
		const v: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
		return v && typeof v === "object" && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/* ------------------------------- generators -------------------------------- */

function codexProviderSection(input: GenerateInput): string[] {
	const lines = [
		CODEX_SECTION_HEADER,
		'name = "UniRoute Gateway"',
		`base_url = "${tomlEscape(input.baseUrl.replace(/\/+$/, ""))}/v1"`,
	];
	if (input.authMode === "env") {
		lines.push(`env_key = "${UNIROUTE_ENV_KEY}"`);
		lines.push(
			`env_key_instructions = "Set ${UNIROUTE_ENV_KEY} dengan API key UniRoute Anda."`,
		);
	} else {
		lines.push(
			`experimental_bearer_token = "${tomlEscape(input.apiKey)}"`,
		);
	}
	return lines;
}

export function buildCodexConfig(input: GenerateInput): string {
	const lines = [
		"# ~/.codex/config.toml — dikelola oleh UniRoute (halaman AI Agents).",
		"# Backup file lama tersimpan di ~/.uniroute/backups/codex/",
	];
	if (input.model) lines.push(`model = "${tomlEscape(input.model)}"`);
	lines.push('model_provider = "uniroute"', "");
	lines.push(...codexProviderSection(input));
	return `${lines.join("\n")}\n`;
}

/** Merge level top-level + section `[model_providers.uniroute]` ke TOML lama. */
export function mergeCodexConfig(existing: string, input: GenerateInput): string {
	const srcLines = existing.replace(/\r\n/g, "\n").split("\n");

	// 1) Top-level scalar keys (sebelum header section pertama).
	let firstSectionIdx = srcLines.findIndex((l) => /^\s*\[/.test(l));
	if (firstSectionIdx === -1) firstSectionIdx = srcLines.length;
	const scalars: Record<string, number> = {};
	for (let i = 0; i < firstSectionIdx; i++) {
		const m = srcLines[i].match(/^(model|model_provider)\s*=/);
		if (m) scalars[m[1]] = i;
	}
	const wanted: [string, string][] = [];
	if (input.model) wanted.push(["model", input.model]);
	wanted.push(["model_provider", "uniroute"]);
	for (const [key, rawValue] of wanted) {
		const line = `${key} = "${tomlEscape(rawValue)}"`;
		if (scalars[key] !== undefined) {
			srcLines[scalars[key]] = line;
		} else {
			// Sisipkan setelah blok komentar/blank di awal file.
			let insertAt = 0;
			while (
				insertAt < firstSectionIdx &&
				(/^\s*#/.test(srcLines[insertAt]) || srcLines[insertAt].trim() === "")
			) {
				insertAt++;
			}
			srcLines.splice(insertAt, 0, line);
			firstSectionIdx++;
			for (const k of Object.keys(scalars)) {
				if (scalars[k] >= insertAt) scalars[k]++;
			}
			scalars[key] = insertAt;
		}
	}

	// 2) Section [model_providers.uniroute]: ganti utuh bila ada.
	const sectionIdx = srcLines.findIndex((l) =>
		/^\[model_providers\.uniroute\]\s*$/.test(l),
	);
	if (sectionIdx === -1) {
		while (srcLines.length > 0 && srcLines[srcLines.length - 1] === "") {
			srcLines.pop();
		}
		srcLines.push("", "# --- added by UniRoute ---", ...codexProviderSection(input));
	} else {
		let end = sectionIdx + 1;
		while (end < srcLines.length && !/^\s*\[/.test(srcLines[end])) end++;
		srcLines.splice(sectionIdx, end - sectionIdx, ...codexProviderSection(input));
	}
	return `${srcLines.join("\n").replace(/\n{3,}/g, "\n\n")}${srcLines.length ? "\n" : ""}`;
}

type JsonPatch = Record<string, unknown>;

/** Deep merge sederhana: object digabung, nilai scalar/array ditimpa. */
function deepMerge(target: Record<string, unknown>, patch: JsonPatch): void {
	for (const [k, v] of Object.entries(patch)) {
		if (
			v && typeof v === "object" && !Array.isArray(v) &&
			target[k] && typeof target[k] === "object" && !Array.isArray(target[k])
		) {
			deepMerge(target[k] as Record<string, unknown>, v as JsonPatch);
		} else {
			target[k] = jsonClone(v);
		}
	}
}

function parseJsonConfig(raw: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("bukan object");
		}
		return parsed as Record<string, unknown>;
	} catch {
		throw new ConfigError(
			"File config yang ada bukan JSON yang valid — perbaiki manual atau restore dari backup. UniRoute tidak akan menimpanya.",
		);
	}
}

export function buildClaudeCodePatch(input: GenerateInput): JsonPatch {
	const env: Record<string, string> = {
		ANTHROPIC_BASE_URL: input.baseUrl.replace(/\/+$/, ""),
		ANTHROPIC_AUTH_TOKEN: input.apiKey,
	};
	if (input.model) env.ANTHROPIC_MODEL = input.model;
	return { env };
}

export function buildOpencodePatch(input: GenerateInput): JsonPatch {
	const models: Record<string, unknown> = {};
	if (input.model) {
		models[input.model] = { name: input.model };
	}
	const provider: Record<string, unknown> = {
		name: "UniRoute",
		package: "@opencode-ai/ai/providers/openai-compatible",
		settings: {
			baseURL: `${input.baseUrl.replace(/\/+$/, "")}/v1`,
			apiKey: input.apiKey,
		},
	};
	if (Object.keys(models).length > 0) provider.models = models;
	const patch: JsonPatch = {
		$schema: "https://opencode.ai/config.json",
		providers: { uniroute: provider },
	};
	if (input.model) patch.model = `uniroute/${input.model}`;
	return patch;
}

export function mergeJsonConfig(
	existing: string,
	patch: JsonPatch,
): string {
	const obj = parseJsonConfig(existing);
	deepMerge(obj, patch);
	return `${JSON.stringify(obj, null, 2)}\n`;
}

/** Konten final config untuk harness, dengan atau tanpa file lama. */
export function buildConfig(
	id: HarnessId,
	input: GenerateInput,
	existing: string | null,
): string {
	if (existing === null || existing.trim() === "") {
		switch (id) {
			case "codex":
				return buildCodexConfig(input);
			case "claude-code":
				return `${JSON.stringify(buildClaudeCodePatch(input), null, 2)}\n`;
			case "opencode":
				return `${JSON.stringify(buildOpencodePatch(input), null, 2)}\n`;
		}
	}
	switch (id) {
		case "codex":
			return mergeCodexConfig(existing, input);
		case "claude-code":
			return mergeJsonConfig(existing, buildClaudeCodePatch(input));
		case "opencode":
			return mergeJsonConfig(existing, buildOpencodePatch(input));
	}
}

/* ----------------------------- backup & restore ---------------------------- */

export type BackupInfo = { file: string; ts: number; size: number };

const BACKUP_FILE_RE = /^[\w.-]+\.bak$/;

function timestampToken(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
		`-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
	);
}

function assertSafeBackupName(file: string): void {
	if (!BACKUP_FILE_RE.test(file) || file.includes("..")) {
		throw new ConfigError("Nama backup tidak valid.");
	}
}

/** Salin config saat ini ke folder backup; return nama file backup. */
export function createBackup(id: HarnessId, home?: string): string | null {
	const cfgPath = resolveConfigAbsPath(id, home);
	if (!existsSync(cfgPath)) return null;
	const dir = backupDir(id, home);
	mkdirSync(dir, { recursive: true });
	const base = path.basename(cfgPath);
	// Nama unik: operasi dalam detik yang sama tidak boleh saling menimpa.
	let name = `${base}.${timestampToken()}${BACKUP_SUFFIX}`;
	for (let n = 2; existsSync(path.join(dir, name)); n++) {
		name = `${base}.${timestampToken()}-${n}${BACKUP_SUFFIX}`;
	}
	copyFileSync(cfgPath, path.join(dir, name));
	return name;
}

export function listBackups(id: HarnessId, home?: string): BackupInfo[] {
	const dir = backupDir(id, home);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => BACKUP_FILE_RE.test(f))
		.map((f) => {
			const st = statSync(path.join(dir, f));
			return { file: f, ts: st.mtimeMs, size: st.size };
		})
		.sort((a, b) => b.ts - a.ts);
}

export function readBackup(id: HarnessId, file: string, home?: string): string {
	assertSafeBackupName(file);
	return readFileSync(path.join(backupDir(id, home), file), "utf8");
}

export function deleteBackup(id: HarnessId, file: string, home?: string): void {
	assertSafeBackupName(file);
	unlinkSync(path.join(backupDir(id, home), file));
}

/** Restore backup → config. Config saat ini di-backup dulu (restore reversible). */
export function restoreBackup(
	id: HarnessId,
	file: string,
	home?: string,
): { safetyBackup: string | null } {
	assertSafeBackupName(file);
	const dir = backupDir(id, home);
	const src = path.join(dir, file);
	if (!existsSync(src)) throw new ConfigError("Backup tidak ditemukan.");
	const safetyBackup = createBackup(id, home);
	copyFileSync(src, resolveConfigAbsPath(id, home));
	return { safetyBackup };
}

/* ------------------------- remove / reset ke default ----------------------- */

function meaningfulToml(lines: string[]): boolean {
	return lines.some((l) => {
		const t = l.trim();
		return t !== "" && !t.startsWith("#");
	});
}

/** Buang semua jejak UniRoute dari config.toml Codex. */
function stripCodexConfig(existing: string): {
	content: string;
	meaningful: boolean;
} {
	const OUR_COMMENTS = [
		"# ~/.codex/config.toml",
		"# Backup file lama tersimpan",
		"# --- added by UniRoute ---",
	];
	// Bila UniRoute adalah provider aktif, nilai `model` top-level juga
	// berasal dari Apply kami → ikut dibersihkan.
	const hadOurProvider = /^model_provider\s*=\s*"uniroute"\s*$/m.test(existing);
	let lines = existing.replace(/\r\n/g, "\n").split("\n").filter((l) => {
		const t = l.trim();
		if (OUR_COMMENTS.some((c) => t.startsWith(c))) return false;
		if (/^model_provider\s*=\s*"uniroute"\s*$/.test(t)) return false;
		if (hadOurProvider && /^model\s*=\s*"/.test(t)) return false;
		return true;
	});

	// Buang blok section [model_providers.uniroute] (sampai header berikutnya).
	const sectionIdx = lines.findIndex((l) =>
		/^\[model_providers\.uniroute\]\s*$/.test(l),
	);
	if (sectionIdx !== -1) {
		let end = sectionIdx + 1;
		while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
		lines.splice(sectionIdx, end - sectionIdx);
	}

	let joined = lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
	if (joined.trim() !== "" && !joined.endsWith("\n")) joined += "\n";
	return { content: joined, meaningful: meaningfulToml(joined.split("\n")) };
}

type JsonStrip = { content: string; meaningful: boolean };

function stripClaudeCode(existing: string): JsonStrip {
	const obj = parseJsonConfig(existing);
	const env = obj.env as Record<string, unknown> | undefined;
	if (env && typeof env === "object" && !Array.isArray(env)) {
		for (const key of [
			"ANTHROPIC_BASE_URL",
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_MODEL",
		]) {
			delete env[key];
		}
		if (Object.keys(env).length === 0) delete obj.env;
	}
	return {
		content: `${JSON.stringify(obj, null, 2)}\n`,
		meaningful: Object.keys(obj).filter((k) => k !== "$schema").length > 0,
	};
}

function stripOpencode(existing: string): JsonStrip {
	const obj = parseJsonConfig(existing);
	const providers = obj.providers as Record<string, unknown> | undefined;
	if (providers && typeof providers === "object" && !Array.isArray(providers)) {
		delete providers.uniroute;
		if (Object.keys(providers).length === 0) delete obj.providers;
	}
	if (typeof obj.model === "string" && obj.model.startsWith("uniroute/")) {
		delete obj.model;
	}
	return {
		content: `${JSON.stringify(obj, null, 2)}\n`,
		meaningful: Object.keys(obj).filter((k) => k !== "$schema").length > 0,
	};
}

export type RemoveResult = {
	path: string;
	safetyBackup: string | null;
	/** true = file ikut dihapus karena tidak ada konten lain selain punya UniRoute. */
	fileDeleted: boolean;
};

/**
 * Kembalikan config harness ke kondisi default: buang entri yang ditulis
 * UniRoute, pertahankan milik user. Bila setelah itu file tinggal kosong/
 * komentar saja, file dihapus (persis kondisi sebelum UniRoute menulis).
 * File saat ini selalu di-backup dulu.
 */
export function removeUniRouteFromConfig(
	id: HarnessId,
	home?: string,
): RemoveResult {
	const target = resolveConfigAbsPath(id, home);
	const existing = readConfig(id, home);
	if (existing === null || existing.trim() === "") {
		throw new ConfigError("Nothing to remove — no config file exists.");
	}
	const safetyBackup = createBackup(id, home);

	let content: string;
	let meaningful: boolean;
	switch (id) {
		case "codex": {
			const r = stripCodexConfig(existing);
			content = r.content;
			meaningful = r.meaningful;
			break;
		}
		case "claude-code": {
			const r = stripClaudeCode(existing);
			content = r.content;
			meaningful = r.meaningful;
			break;
		}
		case "opencode": {
			const r = stripOpencode(existing);
			content = r.content;
			meaningful = r.meaningful;
			break;
		}
	}

	if (!meaningful) {
		unlinkSync(target);
		return { path: target, safetyBackup, fileDeleted: true };
	}
	atomicWrite(target, content);
	return { path: target, safetyBackup, fileDeleted: false };
}

/* --------------------------- MCP auto-registration ------------------------- */

export type McpHarnessId = "codex" | "claude-code" | "opencode";

const MCP_NAME = "uniroute";

/** Perintah default untuk spawn server MCP dari mesin yang sama. */
export function defaultMcpCommand(): string[] {
  const entry = process.argv[1]
    ? path.resolve(process.argv[1])
    : path.join(process.cwd(), "mcp-server.ts");
  return ["bun", entry];
}

function upsertTomlSection(
  srcLines: string[],
  header: string,
  bodyLines: string[],
): string[] {
  const lines = [...srcLines];
  const idx = lines.findIndex((l) => l.trim() === header);
  if (idx !== -1) {
    let end = idx + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
    lines.splice(idx, end - idx, ...bodyLines);
    return lines;
  }
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  lines.push("", ...bodyLines);
  return lines;
}

function removeTomlSection(srcLines: string[], header: string): string[] {
  const lines = [...srcLines];
  const idx = lines.findIndex((l) => l.trim() === header);
  if (idx === -1) return lines;
  let end = idx + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  lines.splice(idx, end - idx);
  return lines;
}

/**
 * Daftarkan MCP server UniRoute ke config harness (backup dulu).
 * Codex: [mcp_servers.uniroute]; Claude Code: mcpServers; OpenCode: mcp.servers.
 */
export function installMcp(
  id: McpHarnessId,
  cmd: string[],
  home?: string,
): RemoveResult {
  if (id === "codex") {
    const target = resolveConfigAbsPath("codex", home);
    const existing = readConfig("codex", home) ?? "";
    const safetyBackup = createBackup("codex", home);
    const body = [
      "[mcp_servers.uniroute]",
      `command = ${tomlEscape(cmd[0] ?? "bun")}`,
      `args = [${cmd.slice(1).map(tomlEscape).join(", ")}]`,
    ];
    const merged = upsertTomlSection(existing.split("\n"), body[0]!, body.slice(1));
    atomicWrite(target, `${merged.join("\n").replace(/\n{3,}/g, "\n\n")}\n`);
    return { path: target, safetyBackup, fileDeleted: false };
  }

  if (id === "claude-code") {
    const target = resolveConfigAbsPath("claude-code", home);
    const raw = readConfig(id, home);
    const obj =
      raw && raw.trim() !== ""
        ? parseJsonConfig(raw)
        : ({} as Record<string, unknown>);
    deepMerge(obj, {
      mcpServers: { uniroute: { command: cmd[0], args: cmd.slice(1) } },
    } as Record<string, unknown>);
    const safetyBackup = existsSync(target) ? createBackup(id, home) : null;
    atomicWrite(target, `${JSON.stringify(obj, null, 2)}\n`);
    return { path: target, safetyBackup, fileDeleted: false };
  }

  const target = resolveConfigAbsPath("opencode", home);
  const raw = readConfig(id, home);
  const obj =
    raw && raw.trim() !== ""
      ? parseJsonConfig(raw)
      : { $schema: "https://opencode.ai/config.json" };
  deepMerge(obj, {
    mcp: { servers: { uniroute: { type: "local", command: cmd } } },
  } as Record<string, unknown>);
  const safetyBackup = existsSync(target) ? createBackup(id, home) : null;
  atomicWrite(target, `${JSON.stringify(obj, null, 2)}\n`);
  return { path: target, safetyBackup, fileDeleted: false };
}

/** Copot registrasi MCP. Config saat ini di-backup dulu. */
export function removeMcp(
  id: McpHarnessId,
  home?: string,
): { removed: boolean } {
  const target = resolveConfigAbsPath(id, home);
  const raw = readConfig(id, home);
  if (!raw || raw.trim() === "") return { removed: false };

  if (id === "codex") {
    createBackup(id, home);
    atomicWrite(target, removeTomlSection(raw.split("\n"), "[mcp_servers.uniroute]").join("\n"));
    return { removed: true };
  }

  const obj = parseJsonConfig(raw);
  createBackup(id, home);
  if (id === "claude-code") {
    const servers = obj.mcpServers as Record<string, unknown> | undefined;
    if (servers) {
      delete servers.uniroute;
      if (Object.keys(servers).length === 0) delete obj.mcpServers;
    }
  } else {
    const mcp = obj.mcp as Record<string, unknown> | undefined;
    const servers = (mcp?.servers ?? null) as Record<string, unknown> | null;
    if (servers) {
      delete servers.uniroute;
      if (Object.keys(servers).length === 0 && mcp) delete obj.mcp;
      if (mcp && Object.keys(mcp).length === 0) delete obj.mcp;
    }
  }
  atomicWrite(target, `${JSON.stringify(obj, null, 2)}\n`);
  return { removed: true };
}

export function isMcpInstalled(id: McpHarnessId, home?: string): boolean {
  const raw = readConfig(id, home);
  if (!raw || raw.trim() === "") return false;
  if (id === "codex") return /^\[mcp_servers\.uniroute\]/m.test(raw);
  const meta = parseJsonMeta(raw);
  if (!meta) return false;
  if (id === "claude-code") {
    const servers = meta.mcpServers as Record<string, unknown> | undefined;
    return !!servers?.uniroute;
  }
  const mcp = meta.mcp as { servers?: Record<string, unknown> } | undefined;
  return !!mcp?.servers?.uniroute;
}

/* -------------------------------- write & read ------------------------------ */

function atomicWrite(filePath: string, content: string): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.uniroute-tmp-${process.pid}`;
	writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, filePath);
}

export function readConfig(id: HarnessId, home?: string): string | null {
	const p = resolveConfigAbsPath(id, home);
	if (!existsSync(p)) return null;
	return readFileSync(p, "utf8");
}

export type WriteResult = {
	content: string;
	/** Nama backup dari file yang tertimpa (null bila file baru). */
	safetyBackup: string | null;
	path: string;
};

/** Generate + tulis config dengan backup otomatis sebelum menimpa. */
export function writeHarnessConfig(
	id: HarnessId,
	input: GenerateInput,
	home?: string,
): WriteResult {
	const target = resolveConfigAbsPath(id, home);
	const existing = readConfig(id, home);

	// Validasi lebih awal untuk JSON: jangan timpa file rusak.
	if (existing !== null && existing.trim() !== "") {
		const meta = HARNESS_REGISTRY[id];
		if (meta.format === "json") parseJsonConfig(existing);
	}

	const content = buildConfig(id, input, existing);
	let safetyBackup: string | null = null;
	if (existing !== null && existing.trim() !== "") {
		safetyBackup = createBackup(id, home);
	}
	atomicWrite(target, content);
	return { content, safetyBackup, path: target };
}

/* ------------------------- CLI detection & settings ------------------------ */

/** Binary CLI yang dideteksi untuk tiap harness. */
const HARNESS_BINS: Record<HarnessId, string[]> = {
	codex: ["codex"],
	"claude-code": ["claude", "claude-code"],
	opencode: ["opencode", "opencode2"],
};

/** Cari executable di PATH (tanpa spawn proses). */
function findOnPath(names: string[]): string | null {
	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	for (const dir of dirs) {
		for (const name of names) {
			const full = path.join(dir, name);
			try {
				accessSync(full, fsConstants.X_OK);
				if (statSync(full).isFile()) return full;
			} catch {
				/* not here */
			}
		}
	}
	return null;
}

function detectCli(id: HarnessId): { installed: boolean; bin: string | null } {
	const bin = findOnPath(HARNESS_BINS[id]);
	return { installed: bin !== null, bin };
}

const REVEAL_SETTING = "allow_api_key_reveal";

/**
 * Reveal key diizinkan bila env `ALLOW_API_KEY_REVEAL=1` ATAU diaktifkan
 * lewat toggle web (tabel settings) — pola sama dengan require_api_key.
 */
export function isKeyRevealAllowed(): boolean {
	if (process.env.ALLOW_API_KEY_REVEAL === "1") return true;
	const row = query("SELECT value FROM settings WHERE key = ?").get(
		REVEAL_SETTING,
	) as { value: string } | undefined;
	return row?.value === "1";
}

export function setKeyRevealAllowed(enabled: boolean): void {
	query(
		"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(REVEAL_SETTING, enabled ? "1" : "0");
}

/* ---------------------------------- status --------------------------------- */

export type HarnessStatus = HarnessMeta & {
	absPath: string;
	exists: boolean;
	size: number | null;
	updatedAt: number | null;
	backups: BackupInfo[];
	/** Apakah binary CLI harness terdeteksi di PATH. */
	cliInstalled: boolean;
	cliBin: string | null;
};

function getStatus(id: HarnessId, home?: string): HarnessStatus {
	const absPath = resolveConfigAbsPath(id, home);
	const exists = existsSync(absPath);
	let size: number | null = null;
	let updatedAt: number | null = null;
	if (exists) {
		const st = statSync(absPath);
		size = st.size;
		updatedAt = st.mtimeMs;
	}
	const cli = detectCli(id);
	return {
		...HARNESS_REGISTRY[id],
		absPath,
		exists,
		size,
		updatedAt,
		backups: listBackups(id, home),
		cliInstalled: cli.installed,
		cliBin: cli.bin,
	};
}

export function statusAll(home?: string): HarnessStatus[] {
	return HARNESS_IDS.map((id) => getStatus(id, home));
}
