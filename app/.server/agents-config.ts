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
import { TtlCache } from "./async-utils";
import { query } from "./db";

/**
 * Configure AI agent CLI harnesses (Codex, Claude Code, OpenCode) to route
 * through UniRoute.
 *
 * Every write backs up the previous file to `~/.uniroute/backups/<harness>/`.
 * Invalid JSON configs are never overwritten; an error is thrown so the user
 * can fix or restore manually.
 */

export type HarnessId = "codex" | "claude-code" | "opencode";

export type HarnessMeta = {
	id: HarnessId;
	name: string;
	description: string;
	/** Config path relative to home (or XDG_CONFIG_HOME for opencode). */
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
			"Adds the 'uniroute' provider in ~/.codex/config.toml and routes model_provider through UniRoute.",
		configPath: ".codex/config.toml",
		format: "toml",
		docsUrl: "https://developers.openai.com/codex/config-reference",
	},
	"claude-code": {
		id: "claude-code",
		name: "Claude Code",
		description:
			"Sets ANTHROPIC_BASE_URL & ANTHROPIC_AUTH_TOKEN in ~/.claude/settings.json without removing existing keys.",
		configPath: path.join(".claude", "settings.json"),
		format: "json",
		docsUrl: "https://code.claude.com/docs/en/settings",
	},
	opencode: {
		id: "opencode",
		name: "OpenCode",
		description:
			"Adds the custom 'uniroute' provider in ~/.config/opencode/opencode.json (respects XDG_CONFIG_HOME).",
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
	/** Gateway base URL, e.g. http://192.168.1.10:3000 (without /v1). */
	baseUrl: string;
	/** Plaintext UniRoute client API key. */
	apiKey: string;
	/** Optional default model. */
	model?: string | null;
	/** Codex only: store token in file ("token") or use env var ("env"). */
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
	return JSON.stringify(value).slice(1, -1);
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
			`env_key_instructions = "Set ${UNIROUTE_ENV_KEY} to your UniRoute API key."`,
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
		"# ~/.codex/config.toml (managed by UniRoute AI Agents page).",
		"# Backups are stored in ~/.uniroute/backups/codex/",
	];
	if (input.model) lines.push(`model = "${tomlEscape(input.model)}"`);
	lines.push('model_provider = "uniroute"', "");
	lines.push(...codexProviderSection(input));
	return `${lines.join("\n")}\n`;
}

/** Merge top-level keys and `[model_providers.uniroute]` into existing TOML. */
export function mergeCodexConfig(existing: string, input: GenerateInput): string {
	const srcLines = existing.replace(/\r\n/g, "\n").split("\n");

	// 1) Top-level scalar keys (before the first section header).
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
			// Insert after leading comment/blank lines.
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

	// 2) Section [model_providers.uniroute]: replace whole block if present.
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

const BLOCKED_MERGE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function deepMerge(target: Record<string, unknown>, patch: JsonPatch): void {
	for (const [k, v] of Object.entries(patch)) {
		if (BLOCKED_MERGE_KEYS.has(k)) continue;
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
			throw new Error("not an object");
		}
		return parsed as Record<string, unknown>;
	} catch {
		throw new ConfigError(
			"Existing config file is not valid JSON. Fix it manually or restore from backup; UniRoute will not overwrite it.",
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

/** Final config content for a harness, with or without an existing file. */
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
		throw new ConfigError("Invalid backup filename.");
	}
}

/** Copy current config to the backup directory and return the backup filename. */
export function createBackup(id: HarnessId, home?: string): string | null {
	const cfgPath = resolveConfigAbsPath(id, home);
	if (!existsSync(cfgPath)) return null;
	const dir = backupDir(id, home);
	mkdirSync(dir, { recursive: true });
	const base = path.basename(cfgPath);
	// Disambiguate backups created within the same second.
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

/** Restore a backup to the active config after backing up the current file. */
export function restoreBackup(
	id: HarnessId,
	file: string,
	home?: string,
): { safetyBackup: string | null } {
	assertSafeBackupName(file);
	const dir = backupDir(id, home);
	const src = path.join(dir, file);
	if (!existsSync(src)) throw new ConfigError("Backup not found.");
	const target = resolveConfigAbsPath(id, home);
	const safetyBackup = createBackup(id, home);
	mkdirSync(path.dirname(target), { recursive: true });
	copyFileSync(src, target);
	return { safetyBackup };
}

/* ------------------------- detect UniRoute status -------------------------- */

export type UniRouteDetection = {
	configured: boolean;
	baseUrl: string | null;
	model: string | null;
};

function parseTomlQuotedValue(line: string): string | null {
	const m = line.match(/=\s*"((?:\\.|[^"\\])*)"/);
	if (!m) return null;
	return m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Detect whether UniRoute entries exist in the config content. */
export function detectUniRouteConfig(
	id: HarnessId,
	raw: string | null,
): UniRouteDetection {
	if (!raw || raw.trim() === "") {
		return { configured: false, baseUrl: null, model: null };
	}

	if (id === "codex") {
		const lines = raw.replace(/\r\n/g, "\n").split("\n");
		let firstSectionIdx = lines.findIndex((l) => /^\s*\[/.test(l));
		if (firstSectionIdx === -1) firstSectionIdx = lines.length;

		let topProviderIsUniRoute = false;
		let topModel: string | null = null;
		for (let i = 0; i < firstSectionIdx; i++) {
			const t = lines[i]!.trim();
			if (/^model_provider\s*=\s*"uniroute"\s*$/.test(t)) {
				topProviderIsUniRoute = true;
			} else if (/^model\s*=/.test(t)) {
				topModel = parseTomlQuotedValue(t);
			}
		}

		const sectionIdx = lines.findIndex((l) => l.trim() === CODEX_SECTION_HEADER);
		let baseUrl: string | null = null;
		if (sectionIdx !== -1) {
			for (let i = sectionIdx + 1; i < lines.length; i++) {
				if (/^\s*\[/.test(lines[i]!)) break;
				const t = lines[i]!.trim();
				if (/^base_url\s*=/.test(t)) {
					baseUrl = parseTomlQuotedValue(t);
					break;
				}
			}
		}

		const configured = topProviderIsUniRoute || sectionIdx !== -1;
		return {
			configured,
			baseUrl,
			model: topProviderIsUniRoute ? topModel : null,
		};
	}

	const meta = parseJsonMeta(raw);
	if (!meta) return { configured: false, baseUrl: null, model: null };

	if (id === "claude-code") {
		const env =
			meta.env && typeof meta.env === "object" && !Array.isArray(meta.env)
				? (meta.env as Record<string, unknown>)
				: null;
		const baseUrl =
			typeof env?.ANTHROPIC_BASE_URL === "string" && env.ANTHROPIC_BASE_URL.trim()
				? env.ANTHROPIC_BASE_URL.trim()
				: null;
		const authToken =
			typeof env?.ANTHROPIC_AUTH_TOKEN === "string" &&
			env.ANTHROPIC_AUTH_TOKEN.trim()
				? env.ANTHROPIC_AUTH_TOKEN.trim()
				: null;
		const model =
			typeof env?.ANTHROPIC_MODEL === "string" && env.ANTHROPIC_MODEL.trim()
				? env.ANTHROPIC_MODEL.trim()
				: null;
		return {
			configured: Boolean(baseUrl || authToken),
			baseUrl,
			model,
		};
	}

	const providers =
		meta.providers &&
		typeof meta.providers === "object" &&
		!Array.isArray(meta.providers)
			? (meta.providers as Record<string, unknown>)
			: null;
	const ur =
		providers?.uniroute &&
		typeof providers.uniroute === "object" &&
		!Array.isArray(providers.uniroute)
			? (providers.uniroute as Record<string, unknown>)
			: null;
	const settings =
		ur?.settings &&
		typeof ur.settings === "object" &&
		!Array.isArray(ur.settings)
			? (ur.settings as Record<string, unknown>)
			: null;
	const baseUrl =
		typeof settings?.baseURL === "string" && settings.baseURL.trim()
			? settings.baseURL.trim()
			: null;
	const model =
		typeof meta.model === "string" && meta.model.startsWith("uniroute/")
			? meta.model.slice("uniroute/".length)
			: null;
	return {
		configured: Boolean(ur || model),
		baseUrl,
		model,
	};
}

/* ------------------------- remove / reset ke default ----------------------- */

function meaningfulToml(lines: string[]): boolean {
	return lines.some((l) => {
		const t = l.trim();
		return t !== "" && !t.startsWith("#");
	});
}

/** Remove all UniRoute entries from Codex config.toml. */
function stripCodexConfig(existing: string): {
	content: string;
	meaningful: boolean;
} {
	const OUR_COMMENTS = [
		"# ~/.codex/config.toml",
		"# Backups are stored",
		"# --- added by UniRoute ---",
	];
	const rawLines = existing.replace(/\r\n/g, "\n").split("\n");
	let firstSectionIdx = rawLines.findIndex((l) => /^\s*\[/.test(l));
	if (firstSectionIdx === -1) firstSectionIdx = rawLines.length;

	// If UniRoute is the active top-level provider, top-level `model` also came from Apply.
	const hadOurProvider = rawLines
		.slice(0, firstSectionIdx)
		.some((l) => /^model_provider\s*=\s*"uniroute"\s*$/.test(l.trim()));

	const lines = rawLines.filter((l, idx) => {
		const t = l.trim();
		if (OUR_COMMENTS.some((c) => t.startsWith(c))) return false;
		if (idx < firstSectionIdx) {
			if (/^model_provider\s*=\s*"uniroute"\s*$/.test(t)) return false;
			if (hadOurProvider && /^model\s*=\s*"/.test(t)) return false;
		}
		return true;
	});

	// Remove [model_providers.uniroute] block up to the next section header.
	const sectionIdx = lines.findIndex((l) => l.trim() === CODEX_SECTION_HEADER);
	if (sectionIdx !== -1) {
		let end = sectionIdx + 1;
		while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
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
	/** true when the file was deleted because only UniRoute entries remained. */
	fileDeleted: boolean;
};

/**
 * Remove UniRoute entries from the harness config while preserving user keys.
 * Backs up the current file first and deletes it if no other content remains.
 */
export function removeUniRouteFromConfig(
	id: HarnessId,
	home?: string,
): RemoveResult {
	const target = resolveConfigAbsPath(id, home);
	const existing = readConfig(id, home);
	if (existing === null || existing.trim() === "") {
		throw new ConfigError("Nothing to remove: no config file exists.");
	}
	if (!detectUniRouteConfig(id, existing).configured) {
		throw new ConfigError("UniRoute is not configured in this file.");
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

/** Default command to spawn the local MCP server. */
export function defaultMcpCommand(): string[] {
  const root = process.env.UNIROUTE_ROOT ?? process.cwd();
  return ["bun", path.join(root, "app", ".server", "mcp-server.ts")];
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
 * Register UniRoute MCP server in the harness config after creating a backup.
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
      `command = "${tomlEscape(cmd[0] ?? "bun")}"`,
      `args = [${cmd.slice(1).map((a) => `"${tomlEscape(a)}"`).join(", ")}]`,
    ];
    const merged = upsertTomlSection(
      existing.replace(/\r\n/g, "\n").split("\n"),
      body[0]!,
      body,
    );
    const out = merged.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
    atomicWrite(target, `${out}${out.endsWith("\n") ? "" : "\n"}`);
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

/** Unregister MCP from the harness config after creating a backup. */
export function removeMcp(
  id: McpHarnessId,
  home?: string,
): { removed: boolean } {
  const target = resolveConfigAbsPath(id, home);
  const raw = readConfig(id, home);
  if (!raw || raw.trim() === "") return { removed: false };

  if (id === "codex") {
    createBackup(id, home);
    const cleaned = removeTomlSection(
      raw.replace(/\r\n/g, "\n").split("\n"),
      "[mcp_servers.uniroute]",
    )
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, "");
    atomicWrite(target, cleaned.trim() ? `${cleaned.trimEnd()}\n` : "");
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
      if (Object.keys(servers).length === 0 && mcp) delete mcp.servers;
      if (mcp && Object.keys(mcp).length === 0) delete obj.mcp;
    }
  }
  atomicWrite(target, `${JSON.stringify(obj, null, 2)}\n`);
  return { removed: true };
}

export function detectMcpInstalled(
  id: McpHarnessId,
  raw: string | null,
): boolean {
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

export function isMcpInstalled(id: McpHarnessId, home?: string): boolean {
  return detectMcpInstalled(id, readConfig(id, home));
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
	/** Backup filename of the overwritten file (null for new files). */
	safetyBackup: string | null;
	path: string;
};

/** Generate and write harness config with automatic backup before overwriting. */
export function writeHarnessConfig(
	id: HarnessId,
	input: GenerateInput,
	home?: string,
): WriteResult {
	const target = resolveConfigAbsPath(id, home);
	const existing = readConfig(id, home);

	// Validate JSON upfront so malformed configs are never overwritten.
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

/** CLI binaries detected per harness. */
const HARNESS_BINS: Record<HarnessId, string[]> = {
	codex: ["codex"],
	"claude-code": ["claude", "claude-code"],
	opencode: ["opencode", "opencode2"],
};

const cliPathCache = new TtlCache<string, { hit: string | null }>(16, 300_000);

function findOnPath(names: string[]): string | null {
	const pathEnv = process.env.PATH ?? "";
	const cacheKey = `${pathEnv}|${names.join(",")}`;
	const cached = cliPathCache.get(cacheKey);
	if (cached) return cached.hit;

	const dirs = pathEnv.split(path.delimiter).filter(Boolean);
	const isWin = process.platform === "win32";
	const exts = isWin
		? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
				.split(";")
				.filter(Boolean)
				.map((e) => e.toLowerCase())
		: [];
	let resolved: string | null = null;
	outer: for (const dir of dirs) {
		for (const name of names) {
			const candidates = isWin
				? [name, ...exts.map((ext) => `${name}${ext}`)]
				: [name];
			for (const candidate of candidates) {
				const full = path.join(dir, candidate);
				try {
					accessSync(full, isWin ? fsConstants.F_OK : fsConstants.X_OK);
					if (statSync(full).isFile()) {
						resolved = full;
						break outer;
					}
				} catch {
					/* not here */
				}
			}
		}
	}
	cliPathCache.set(cacheKey, { hit: resolved });
	return resolved;
}

function detectCli(id: HarnessId): { installed: boolean; bin: string | null } {
	const bin = findOnPath(HARNESS_BINS[id]);
	return { installed: bin !== null, bin };
}

const REVEAL_SETTING = "allow_api_key_reveal";

export function isKeyRevealLockedByEnv(): boolean {
	return process.env.ALLOW_API_KEY_REVEAL === "1";
}

/** Key reveal is allowed when ALLOW_API_KEY_REVEAL=1 or enabled in settings. */
export function isKeyRevealAllowed(): boolean {
	if (isKeyRevealLockedByEnv()) return true;
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
	/** true only when UniRoute entries exist in the config file. */
	unirouteConfigured: boolean;
	unirouteBaseUrl: string | null;
	unirouteModel: string | null;
	size: number | null;
	updatedAt: number | null;
	backups: BackupInfo[];
	/** Whether the harness CLI binary is detected on PATH. */
	cliInstalled: boolean;
	cliBin: string | null;
	mcpInstalled: boolean;
};

function getStatus(id: HarnessId, home?: string): HarnessStatus {
	const absPath = resolveConfigAbsPath(id, home);
	const exists = existsSync(absPath);
	let size: number | null = null;
	let updatedAt: number | null = null;
	let raw: string | null = null;
	if (exists) {
		const st = statSync(absPath);
		size = st.size;
		updatedAt = st.mtimeMs;
		try {
			raw = readFileSync(absPath, "utf8");
		} catch {
			raw = null;
		}
	}
	const detected = detectUniRouteConfig(id, raw);
	const cli = detectCli(id);
	return {
		...HARNESS_REGISTRY[id],
		absPath,
		exists,
		unirouteConfigured: detected.configured,
		unirouteBaseUrl: detected.baseUrl,
		unirouteModel: detected.model,
		size,
		updatedAt,
		backups: listBackups(id, home),
		cliInstalled: cli.installed,
		cliBin: cli.bin,
		mcpInstalled: detectMcpInstalled(id, raw),
	};
}

export function statusAll(home?: string): HarnessStatus[] {
	return HARNESS_IDS.map((id) => getStatus(id, home));
}
