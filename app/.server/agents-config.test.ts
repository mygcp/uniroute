import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	ConfigError,
	HARNESS_IDS,
	buildClaudeCodePatch,
	buildCodexConfig,
	buildConfig,
	buildOpencodePatch,
	detectUniRouteConfig,
	installMcp,
	isMcpInstalled,
	mergeCodexConfig,
	mergeJsonConfig,
	createBackup,
	deleteBackup,
	listBackups,
	readConfig,
	removeMcp,
	removeUniRouteFromConfig,
	restoreBackup,
	statusAll,
	writeHarnessConfig,
} from "./agents-config";

const INPUT = {
	baseUrl: "http://192.168.1.10:3000",
	apiKey: "sk-test-123",
	model: "big-pickle",
	authMode: "token" as const,
};

function tmpHome(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "uniroute-agents-"));
	return dir;
}

describe("codex generator", () => {
	test("fresh config has provider section + top-level keys", () => {
		const out = buildCodexConfig(INPUT);
		expect(out).toContain('model_provider = "uniroute"');
		expect(out).toContain('model = "big-pickle"');
		expect(out).toContain("[model_providers.uniroute]");
		expect(out).toContain('base_url = "http://192.168.1.10:3000/v1"');
		expect(out).toContain('experimental_bearer_token = "sk-test-123"');
	});

	test("env auth mode uses env_key instead of token", () => {
		const out = buildCodexConfig({ ...INPUT, authMode: "env", model: null });
		expect(out).toContain('env_key = "UNIROUTE_API_KEY"');
		expect(out).not.toContain("experimental_bearer_token");
		expect(out).not.toContain("model =");
	});

	test("merge into existing toml replaces section and keeps other sections", () => {
		const existing = [
			"# my custom config",
			'model = "old-model"',
			'approval_policy = "on-request"',
			"",
			"[mcp_servers.playwright]",
			'command = ["bunx", "@playwright/mcp"]',
			"",
			"[model_providers.uniroute]",
			'name = "stale"',
			'base_url = "http://old:1/v1"',
			"",
			"[profiles.work]",
			'model = "gpt-5"',
		].join("\n");
		const out = mergeCodexConfig(existing, INPUT);
		expect(out).toContain("# my custom config");
		expect(out).toContain('model = "big-pickle"'); // replaced
		expect(out).toContain('approval_policy = "on-request"');
		expect(out).not.toContain('"stale"');
		expect(out).not.toContain("http://old:1/v1");
		expect(out).toContain('base_url = "http://192.168.1.10:3000/v1"');
		// unrelated sections untouched & still present
		expect(out).toContain("[mcp_servers.playwright]");
		expect(out).toContain("[profiles.work]");
	});

	test("merge appends section when missing", () => {
		const existing = 'approval_policy = "never"\n';
		const out = mergeCodexConfig(existing, { ...INPUT, model: null });
		expect(out).toContain('model_provider = "uniroute"');
		expect(out).toContain("[model_providers.uniroute]");
		expect(out).toContain('approval_policy = "never"');
	});
});

describe("json generators", () => {
	test("claude-code patch shape", () => {
		const patch = buildClaudeCodePatch(INPUT) as Record<string, Record<string, string>>;
		expect(patch.env.ANTHROPIC_BASE_URL).toBe("http://192.168.1.10:3000");
		expect(patch.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-test-123");
		expect(patch.env.ANTHROPIC_MODEL).toBe("big-pickle");
	});

	test("opencode patch follows V2 provider schema", () => {
		const patch = buildOpencodePatch(INPUT) as {
			$schema: string;
			model: string;
			providers: Record<string, Record<string, unknown>>;
		};
		expect(patch.$schema).toBe("https://opencode.ai/config.json");
		expect(patch.model).toBe("uniroute/big-pickle");
		const p = patch.providers.uniroute;
		expect(p.package).toBe("@opencode-ai/ai/providers/openai-compatible");
		expect((p.settings as Record<string, unknown>).baseURL).toBe(
			"http://192.168.1.10:3000/v1",
		);
	});

	test("merge preserves unrelated keys and refuses invalid json", () => {
		const existing = JSON.stringify({
			model: "openai/gpt-5",
			permissions: [{ action: "shell", effect: "ask" }],
		});
		const merged = mergeJsonConfig(existing, buildOpencodePatch(INPUT));
		const obj = JSON.parse(merged);
		expect(obj.model).toBe("uniroute/big-pickle"); // overwritten by patch
		expect(obj.permissions).toEqual([{ action: "shell", effect: "ask" }]);
		expect(obj.providers.uniroute.settings.apiKey).toBe("sk-test-123");

		expect(() => mergeJsonConfig("{ not json", buildClaudeCodePatch(INPUT))).toThrow(
			ConfigError,
		);
	});

	test("buildConfig merges for all harnesses given existing content", () => {
		for (const id of HARNESS_IDS) {
			const existing = id === "codex" ? "# c\n" : "{}";
			const out = buildConfig(id, INPUT, existing);
			expect(out).toContain("192.168.1.10:3000");
		}
	});
});

describe("backup / restore / write (fs)", () => {
	test("write → backup → modify → restore roundtrip", () => {
		const home = tmpHome();
		try {
			// first write creates the file, no backup yet
			const r1 = writeHarnessConfig("claude-code", INPUT, home);
			expect(r1.safetyBackup).toBeNull();
			expect(existsSync(r1.path)).toBe(true);

			// second write backs up the previous version
			const r2 = writeHarnessConfig("opencode", INPUT, home); // different harness, own file
			expect(r2.safetyBackup).toBeNull();
			const r3 = writeHarnessConfig(
				"claude-code",
				{ ...INPUT, model: "changed-model" },
				home,
			);
			expect(r3.safetyBackup).not.toBeNull();
			expect(listBackups("claude-code", home)).toHaveLength(1);

			// restore brings back old content
			const backupFile = listBackups("claude-code", home)[0]!.file;
			restoreBackup("claude-code", backupFile, home);
			const restored = readConfig("claude-code", home)!;
			expect(restored).toContain('"big-pickle"');

			// restore created a safety backup of the newer version
			expect(listBackups("claude-code", home)).toHaveLength(2);

			deleteBackup("claude-code", backupFile, home);
			expect(() => restoreBackup("claude-code", backupFile, home)).toThrow(ConfigError);

			rmSync(home, { recursive: true, force: true });
		} catch (e) {
			rmSync(home, { recursive: true, force: true });
			throw e;
		}
	});

	test("refuses unsafe backup filenames", () => {
		const home = tmpHome();
		try {
			expect(() =>
				restoreBackup("codex" , "../../etc/passwd.bak", home),
			).toThrow(ConfigError);
			rmSync(home, { recursive: true, force: true });
		} catch (e) {
			rmSync(home, { recursive: true, force: true });
			throw e;
		}
	});

	test("invalid existing json is never overwritten", () => {
		const home = tmpHome();
		try {
			mkdirSync(path.join(home, ".claude"), { recursive: true });
			const cfg = path.join(home, ".claude", "settings.json");
			writeFileSync(cfg, "{ broken json !!");
			expect(() => writeHarnessConfig("claude-code", INPUT, home)).toThrow(ConfigError);
			expect(readFileSync(cfg, "utf8")).toBe("{ broken json !!");
			rmSync(home, { recursive: true, force: true });
		} catch (e) {
			rmSync(home, { recursive: true, force: true });
			throw e;
		}
	});

	test("fresh write is valid json/toml-ish and idempotent merge keeps single section", () => {
		const home = tmpHome();
		try {
			writeHarnessConfig("codex", INPUT, home);
			writeHarnessConfig("codex", INPUT, home); // merge over itself
			const content = readConfig("codex", home)!;
			expect(content.match(/\[model_providers\.uniroute\]/g)?.length ?? 0).toBe(1);
			expect(content.match(/model_provider\s*=/g)?.length ?? 0).toBe(1);
			rmSync(home, { recursive: true, force: true });
		} catch (e) {
			rmSync(home, { recursive: true, force: true });
			throw e;
		}
	});
});

describe("remove / reset to default", () => {
	test("codex: strips our entries, keeps user sections; deletes file when empty", () => {
		const home = tmpHome();
		try {
			// Fresh file contains ONLY UniRoute content → remove deletes the file.
			writeHarnessConfig("codex", INPUT, home);
			const r1 = removeUniRouteFromConfig("codex", home);
			expect(r1.fileDeleted).toBe(true);
			expect(existsSync(r1.path)).toBe(false);

			// Merged user config keeps their parts after removal.
			const existing = [
				"# my custom config",
				'approval_policy = "on-request"',
				"",
				"[mcp_servers.playwright]",
				'command = ["bunx"]',
			].join("\n");
			mkdirSync(path.join(home, ".codex"), { recursive: true });
			writeFileSync(path.join(home, ".codex", "config.toml"), existing);
			writeHarnessConfig("codex", INPUT, home); // merge ours in
			const r2 = removeUniRouteFromConfig("codex", home);
			expect(r2.fileDeleted).toBe(false);
			const kept = readFileSync(r2.path, "utf8");
			expect(kept).toContain('approval_policy = "on-request"');
			expect(kept).toContain("[mcp_servers.playwright]");
			expect(kept).not.toContain("model_providers.uniroute");
			expect(kept).not.toContain('model_provider = "uniroute"');
			rmSync(home, { recursive: true, force: true });
		} catch (e) {
			rmSync(home, { recursive: true, force: true });
			throw e;
		}
	});

	test("claude-code & opencode: removes only UniRoute keys", () => {
		const home = tmpHome();
		try {
			writeHarnessConfig("claude-code", INPUT, home);
			const r = removeUniRouteFromConfig("claude-code", home);
			expect(r.fileDeleted).toBe(true); // fresh file had nothing else
			expect(existsSync(r.path)).toBe(false);

			const ocPath = path.join(home, ".config", "opencode", "opencode.json");
			mkdirSync(path.dirname(ocPath), { recursive: true });
			writeFileSync(
				ocPath,
				JSON.stringify({ theme: "dark", providers: { other: {} } }),
			);
			writeHarnessConfig("opencode", INPUT, home);
			const r2 = removeUniRouteFromConfig("opencode", home);
			expect(r2.fileDeleted).toBe(false);
			const obj = JSON.parse(readFileSync(r2.path, "utf8"));
			expect(obj.theme).toBe("dark");
			expect(obj.providers.other).toEqual({});
			expect(obj.providers.uniroute).toBeUndefined();
			expect(obj.model).toBeUndefined();
			rmSync(home, { recursive: true, force: true });
		} catch (e) {
			rmSync(home, { recursive: true, force: true });
			throw e;
		}
	});

	test("remove without existing file throws", () => {
		const home = tmpHome();
		try {
			expect(() => removeUniRouteFromConfig("opencode", home)).toThrow(ConfigError);
			rmSync(home, { recursive: true, force: true });
		} catch (e) {
			rmSync(home, { recursive: true, force: true });
			throw e;
		}
	});

	test("detectUniRouteConfig & statusAll distinguish existing user config from linked UniRoute config", () => {
		const home = tmpHome();
		try {
			// User already has a Codex config with [profiles.work], no UniRoute yet.
			mkdirSync(path.join(home, ".codex"), { recursive: true });
			writeFileSync(
				path.join(home, ".codex", "config.toml"),
				['approval_policy = "on-request"', "", "[profiles.work]", 'model = "gpt-5"'].join("\n"),
			);
			let codexStatus = statusAll(home).find((s) => s.id === "codex")!;
			expect(codexStatus.exists).toBe(true);
			expect(codexStatus.unirouteConfigured).toBe(false);
			expect(() => removeUniRouteFromConfig("codex", home)).toThrow(ConfigError);

			// Apply UniRoute -> unirouteConfigured becomes true with baseUrl + model.
			writeHarnessConfig("codex", INPUT, home);
			codexStatus = statusAll(home).find((s) => s.id === "codex")!;
			expect(codexStatus.unirouteConfigured).toBe(true);
			expect(codexStatus.unirouteBaseUrl).toBe("http://192.168.1.10:3000/v1");
			expect(codexStatus.unirouteModel).toBe("big-pickle");

			// Remove UniRoute -> file still exists for user settings, but unirouteConfigured is false
			// and [profiles.work]'s model is preserved!
			const res = removeUniRouteFromConfig("codex", home);
			expect(res.fileDeleted).toBe(false);
			const after = readConfig("codex", home)!;
			expect(after).toContain("[profiles.work]");
			expect(after).toContain('model = "gpt-5"');
			expect(detectUniRouteConfig("codex", after).configured).toBe(false);

			codexStatus = statusAll(home).find((s) => s.id === "codex")!;
			expect(codexStatus.exists).toBe(true);
			expect(codexStatus.unirouteConfigured).toBe(false);
			expect(codexStatus.unirouteBaseUrl).toBeNull();
			expect(codexStatus.unirouteModel).toBeNull();

			// Restore works even if parent dir was removed.
			rmSync(path.join(home, ".codex"), { recursive: true, force: true });
			const bak = listBackups("codex", home)[0]!.file;
			restoreBackup("codex", bak, home);
			expect(existsSync(path.join(home, ".codex", "config.toml"))).toBe(true);

			rmSync(home, { recursive: true, force: true });
		} catch (e) {
			rmSync(home, { recursive: true, force: true });
			throw e;
		}
	});
});

describe("MCP auto-registration", () => {
	test("codex installMcp writes valid quoted TOML with header and roundtrips removeMcp", () => {
		const home = tmpHome();
		try {
			const cmd = ["bun", "C:\\Users\\user\\uniroute\\app\\.server\\mcp-server.ts"];
			installMcp("codex", cmd, home);
			expect(isMcpInstalled("codex", home)).toBe(true);
			const content = readConfig("codex", home)!;
			expect(content).toContain("[mcp_servers.uniroute]");
			expect(content).toContain('command = "bun"');
			expect(content).toContain(
				'args = ["C:\\\\Users\\\\user\\\\uniroute\\\\app\\\\.server\\\\mcp-server.ts"]',
			);

			removeMcp("codex", home);
			expect(isMcpInstalled("codex", home)).toBe(false);
			rmSync(home, { recursive: true, force: true });
		} catch (e) {
			rmSync(home, { recursive: true, force: true });
			throw e;
		}
	});

	test("opencode removeMcp preserves sibling keys inside mcp object", () => {
		const home = tmpHome();
		try {
			const ocPath = path.join(home, ".config", "opencode", "opencode.json");
			mkdirSync(path.dirname(ocPath), { recursive: true });
			writeFileSync(
				ocPath,
				JSON.stringify({ mcp: { enabled: true, servers: {} } }, null, 2),
			);
			installMcp("opencode", ["bun", "mcp-server.ts"], home);
			expect(isMcpInstalled("opencode", home)).toBe(true);

			removeMcp("opencode", home);
			expect(isMcpInstalled("opencode", home)).toBe(false);
			const obj = JSON.parse(readFileSync(ocPath, "utf8"));
			expect(obj.mcp.enabled).toBe(true);
			expect(obj.mcp.servers).toBeUndefined();
			rmSync(home, { recursive: true, force: true });
		} catch (e) {
			rmSync(home, { recursive: true, force: true });
			throw e;
		}
	});
});
