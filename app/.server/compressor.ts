import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { createLimiter, TtlCache } from "./async-utils";
import { getTableVersion, onDbReset, query } from "./db";
import { recordProxyLog } from "./logger";
import type { CanonicalRequest } from "./translate/canonical";
import {
  CAVEMAN_VOICE_DIRECTIVES,
  VALID_CAVEMAN_TYPES,
  VALID_CAVEMAN_VOICES,
  VALID_COMPRESSION_SCOPES,
  VALID_RTK_FILTERS,
  type CavemanVoice,
  type CompressionScope,
} from "../lib/compression-options";
import {
  detectBinaryKind,
  probeTool,
  resolveToolBinary,
  toolsDir,
  type CompressorToolId,
  type ToolKind,
  type ToolStatus,
} from "./compressor-tools";

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;

export type CompressionSettings = {
  rtk_enabled: boolean;
  caveman_enabled: boolean;
  rtk_binary_path: string;
  caveman_binary_path: string;
  rtk_filter: string;
  caveman_type: string;
  caveman_voice: CavemanVoice;
  scope: CompressionScope;
  min_chars: number;
  timeout_ms: number;
  never_worse: boolean;
};

export type StageResult = {
  tool: CompressorToolId;
  kind: ToolKind;
  mode: string;
  inputChars: number;
  outputChars: number;
  savedChars: number;
  savedPct: number;
  durationMs: number;
  tokensBefore?: number;
  tokensAfter?: number;
  detectedType?: string;
  recoveryHandle?: string;
  passedThrough?: boolean;
};

export type CompressResult = {
  output: string;
  usedFallback: boolean;
  durationMs: number;
  stages?: StageResult[];
  error?: string;
};

export type TestCompressionResult = {
  output: string;
  usedFallback: boolean;
  durationMs: number;
  settings: CompressionSettings;
  stages: StageResult[];
  inputChars: number;
  outputChars: number;
  savedChars: number;
  savedPct: number;
  voiceDirective: string | null;
  error?: string;
};

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function findPosixShellOnWindows(): string | null {
  const candidates = [
    typeof Bun !== "undefined" ? Bun.which("sh") : null,
    "C:\\Program Files\\Git\\bin\\sh.exe",
    "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

const spawnPrefixCache = new TtlCache<string, string[]>(64, 30_000);
let cachedSettings: CompressionSettings | null = null;
let cachedSettingsVer = -1;

onDbReset(() => {
  cachedSettings = null;
  cachedSettingsVer = -1;
  spawnPrefixCache.clear();
});

function readHeadBytes(filePath: string, length: number): string {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function resolveSpawnPrefix(binPath: string): string[] {
  const hasPathSep =
    binPath.includes("/") || binPath.includes("\\") || binPath.startsWith(".");
  const target = hasPathSep
    ? resolve(binPath)
    : ((typeof Bun !== "undefined" ? Bun.which(binPath) : null) ?? binPath);

  const cached = spawnPrefixCache.get(target);
  if (cached) return cached;

  let prefix: string[] = [target];
  if (process.platform === "win32") {
    if (/\.(cmd|bat)$/i.test(target)) {
      prefix = ["cmd.exe", "/c", target];
    } else if (hasPathSep && !existsSync(target)) {
      for (const ext of [".exe", ".cmd", ".bat"]) {
        if (existsSync(`${target}${ext}`)) {
          prefix =
            ext === ".exe"
              ? [`${target}${ext}`]
              : ["cmd.exe", "/c", `${target}${ext}`];
          break;
        }
      }
    } else if (existsSync(target)) {
      try {
        const head = readHeadBytes(target, 64);
        if (head.startsWith("#!")) {
          const sh = findPosixShellOnWindows();
          if (sh) prefix = [sh, target];
        }
      } catch {
        /* fall through to direct spawn */
      }
    }
  }

  if (existsSync(prefix[prefix.length - 1]!)) {
    spawnPrefixCache.set(target, prefix);
  }
  return prefix;
}

function buildSpawnCmd(binPath: string, args: string[] = []): string[] {
  const prefix = resolveSpawnPrefix(binPath);
  return args.length === 0 ? prefix : [...prefix, ...args];
}

export function getSettings(): CompressionSettings {
  const ver = getTableVersion("compression_settings");
  if (cachedSettings && cachedSettingsVer === ver) {
    return cachedSettings;
  }

  const row = query(
    `SELECT rtk_enabled, caveman_enabled, rtk_binary_path, caveman_binary_path,
            rtk_filter, caveman_type, caveman_voice, scope, min_chars, timeout_ms, never_worse
     FROM compression_settings WHERE id = 1`,
  ).get() as
    | {
        rtk_enabled: number;
        caveman_enabled: number;
        rtk_binary_path: string | null;
        caveman_binary_path: string | null;
        rtk_filter?: string | null;
        caveman_type?: string | null;
        caveman_voice?: string | null;
        scope?: string | null;
        min_chars?: number | null;
        timeout_ms?: number | null;
        never_worse?: number | null;
      }
    | undefined;

  const rtkFilter =
    row?.rtk_filter && VALID_RTK_FILTERS.has(row.rtk_filter)
      ? row.rtk_filter
      : "auto";
  const cavemanType =
    row?.caveman_type && VALID_CAVEMAN_TYPES.has(row.caveman_type)
      ? row.caveman_type
      : "auto";
  const cavemanVoice = (
    row?.caveman_voice && VALID_CAVEMAN_VOICES.has(row.caveman_voice)
      ? row.caveman_voice
      : "off"
  ) as CavemanVoice;
  const scope = (
    row?.scope && VALID_COMPRESSION_SCOPES.has(row.scope)
      ? row.scope
      : "tool_and_last"
  ) as CompressionScope;

  const parsed: CompressionSettings = {
    rtk_enabled: !!row?.rtk_enabled,
    caveman_enabled: !!row?.caveman_enabled,
    rtk_binary_path: (row?.rtk_binary_path ?? "").trim(),
    caveman_binary_path: (row?.caveman_binary_path ?? "").trim(),
    rtk_filter: rtkFilter,
    caveman_type: cavemanType,
    caveman_voice: cavemanVoice,
    scope,
    min_chars: clampInt(row?.min_chars ?? 400, 400, 0, 100_000),
    timeout_ms: clampInt(
      row?.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
    never_worse: row?.never_worse == null ? true : row.never_worse !== 0,
  };
  cachedSettings = parsed;
  cachedSettingsVer = ver;
  return parsed;
}

export function saveSettings(
  patch: Partial<CompressionSettings>,
): CompressionSettings {
  const cur = getSettings();
  const next: CompressionSettings = {
    rtk_enabled: patch.rtk_enabled ?? cur.rtk_enabled,
    caveman_enabled: patch.caveman_enabled ?? cur.caveman_enabled,
    rtk_binary_path: (patch.rtk_binary_path ?? cur.rtk_binary_path).trim(),
    caveman_binary_path: (
      patch.caveman_binary_path ?? cur.caveman_binary_path
    ).trim(),
    rtk_filter:
      patch.rtk_filter && VALID_RTK_FILTERS.has(patch.rtk_filter)
        ? patch.rtk_filter
        : cur.rtk_filter,
    caveman_type:
      patch.caveman_type && VALID_CAVEMAN_TYPES.has(patch.caveman_type)
        ? patch.caveman_type
        : cur.caveman_type,
    caveman_voice:
      patch.caveman_voice && VALID_CAVEMAN_VOICES.has(patch.caveman_voice)
        ? patch.caveman_voice
        : cur.caveman_voice,
    scope:
      patch.scope && VALID_COMPRESSION_SCOPES.has(patch.scope)
        ? patch.scope
        : cur.scope,
    min_chars: clampInt(
      patch.min_chars ?? cur.min_chars,
      cur.min_chars,
      0,
      100_000,
    ),
    timeout_ms: clampInt(
      patch.timeout_ms ?? cur.timeout_ms,
      cur.timeout_ms,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
    never_worse: patch.never_worse ?? cur.never_worse,
  };

  query(
    `INSERT INTO compression_settings
       (id, rtk_enabled, caveman_enabled, rtk_binary_path, caveman_binary_path,
        rtk_filter, caveman_type, caveman_voice, scope, min_chars, timeout_ms, never_worse, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       rtk_enabled = excluded.rtk_enabled,
       caveman_enabled = excluded.caveman_enabled,
       rtk_binary_path = excluded.rtk_binary_path,
       caveman_binary_path = excluded.caveman_binary_path,
       rtk_filter = excluded.rtk_filter,
       caveman_type = excluded.caveman_type,
       caveman_voice = excluded.caveman_voice,
       scope = excluded.scope,
       min_chars = excluded.min_chars,
       timeout_ms = excluded.timeout_ms,
       never_worse = excluded.never_worse,
       updated_at = unixepoch()`,
  ).run(
    next.rtk_enabled ? 1 : 0,
    next.caveman_enabled ? 1 : 0,
    next.rtk_binary_path,
    next.caveman_binary_path,
    next.rtk_filter,
    next.caveman_type,
    next.caveman_voice,
    next.scope,
    next.min_chars,
    next.timeout_ms,
    next.never_worse ? 1 : 0,
  );

  cachedSettings = next;
  cachedSettingsVer = getTableVersion("compression_settings");
  spawnPrefixCache.clear();
  return next;
}

export async function getToolsStatus(): Promise<{
  rtk: ToolStatus;
  caveman: ToolStatus;
  toolsDir: string;
}> {
  const settings = getSettings();
  const [rtk, caveman] = await Promise.all([
    probeTool("rtk", settings.rtk_binary_path),
    probeTool("caveman", settings.caveman_binary_path),
  ]);
  return {
    rtk,
    caveman,
    toolsDir: toolsDir(),
  };
}

export function isEnabled(): {
  rtk: boolean;
  caveman: boolean;
  voice?: CavemanVoice;
} {
  const { rtk_enabled, caveman_enabled } = getSettings();
  return { rtk: rtk_enabled, caveman: caveman_enabled };
}

/**
 * Run a compressor binary via stdin->stdout with configured timeout.
 * Uses node:child_process for both Bun and Node.js compatibility; throws on failure.
 */
async function runBinary(
  binPath: string,
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const [command, ...cmdArgs] = buildSpawnCmd(binPath, args);
  if (!command) throw new Error("Empty binary command");

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timedOut = false;
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const child = spawn(command, cmdArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const finish = (
      err: Error | null,
      res?: { stdout: string; stderr: string },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) rejectPromise(err);
      else resolvePromise(res!);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
      finish(new Error(`binary timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      finish(err);
    });

    child.stdout.on("data", (chunk: Buffer | Uint8Array) => {
      outChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | Uint8Array) => {
      errChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on("close", (code) => {
      if (timedOut) {
        finish(new Error(`binary timed out after ${timeoutMs}ms`));
        return;
      }
      const stdout = Buffer.concat(outChunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");
      if (code !== 0) {
        const detail = stderr.trim().split("\n")[0];
        finish(
          new Error(
            detail
              ? `binary exited ${code}: ${detail}`
              : `binary exited with code ${code ?? "unknown"}`,
          ),
        );
        return;
      }
      finish(null, { stdout, stderr });
    });

    child.stdin.on("error", () => {
      /* ignore EPIPE if binary exits before reading full stdin */
    });
    child.stdin.end(input, "utf8");
  });
}

type CavemanStderrReport = {
  tokens_before?: number;
  tokens_after?: number;
  compressor?: string;
  content_type?: string;
  handle?: string;
  passed_through?: boolean;
  error?: string;
  TokensBefore?: number;
  TokensAfter?: number;
  Compressor?: string;
  ContentType?: string;
  Handle?: string;
  PassedThrough?: boolean;
};

function parseCavemanReport(stderr: string): CavemanStderrReport | null {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line) as CavemanStderrReport;
    } catch {
      /* skip non-json stderr lines */
    }
  }
  return null;
}

function pctSaved(before: number, after: number): number {
  if (before <= 0 || after >= before) return 0;
  return Math.round(((before - after) / before) * 100);
}

async function runStage(
  tool: CompressorToolId,
  configuredPath: string,
  mode: string,
  input: string,
  timeoutMs: number,
  neverWorse: boolean,
): Promise<{ output: string; stage: StageResult }> {
  const start = Date.now();
  const { resolvedPath } = resolveToolBinary(tool, configuredPath);
  if (!resolvedPath) {
    const label = tool === "rtk" ? "RTK" : "Caveman Engine";
    throw new Error(
      `${label} binary not found. Download it on the Compression page or configure a valid binary path.`,
    );
  }

  const { kind } = await detectBinaryKind(tool, resolvedPath);
  let args: string[] = [];
  if (kind === "rtk-cli") {
    args = mode && mode !== "auto" ? ["pipe", "-f", mode] : ["pipe"];
  } else if (kind === "caveman-engine") {
    args = mode && mode !== "auto" ? ["compress", "--type", mode] : ["compress"];
  }

  const { stdout, stderr } = await runBinary(resolvedPath, args, input, timeoutMs);
  const durationMs = Date.now() - start;

  // Fail-safe: empty output or larger output (when never_worse enabled) reverts to input
  let output = input.length > 0 && stdout.length === 0 ? input : stdout;
  let guardedPassthrough = false;
  if (neverWorse && output.length > input.length) {
    output = input;
    guardedPassthrough = true;
  }

  const inputChars = input.length;
  const outputChars = output.length;

  const stage: StageResult = {
    tool,
    kind,
    mode,
    inputChars,
    outputChars,
    savedChars: Math.max(0, inputChars - outputChars),
    savedPct: pctSaved(inputChars, outputChars),
    durationMs,
    passedThrough: guardedPassthrough || output === input,
  };

  if (kind === "caveman-engine") {
    const report = parseCavemanReport(stderr);
    if (report) {
      const tb = report.tokens_before ?? report.TokensBefore;
      const ta = report.tokens_after ?? report.TokensAfter;
      if (typeof tb === "number") stage.tokensBefore = tb;
      if (typeof ta === "number") stage.tokensAfter = ta;
      stage.detectedType =
        report.compressor ??
        report.Compressor ??
        report.content_type ??
        report.ContentType ??
        undefined;
      stage.recoveryHandle = report.handle ?? report.Handle ?? undefined;
      stage.passedThrough =
        guardedPassthrough ||
        (report.passed_through ?? report.PassedThrough ?? output === input);
    }
  }

  return { output, stage };
}

async function runPipeline(
  settings: CompressionSettings,
  input: string,
  logMessage: string,
): Promise<{
  output: string;
  usedFallback: boolean;
  durationMs: number;
  stages: StageResult[];
  error?: string;
}> {
  const start = Date.now();
  if (!settings.rtk_enabled && !settings.caveman_enabled) {
    return { output: input, usedFallback: false, durationMs: 0, stages: [] };
  }

  const stages: StageResult[] = [];
  try {
    let out = input;
    if (settings.rtk_enabled) {
      const r = await runStage(
        "rtk",
        settings.rtk_binary_path,
        settings.rtk_filter,
        out,
        settings.timeout_ms,
        settings.never_worse,
      );
      out = r.output;
      stages.push(r.stage);
    }
    if (settings.caveman_enabled) {
      const r = await runStage(
        "caveman",
        settings.caveman_binary_path,
        settings.caveman_type,
        out,
        settings.timeout_ms,
        settings.never_worse,
      );
      out = r.output;
      stages.push(r.stage);
    }
    return {
      output: out,
      usedFallback: false,
      durationMs: Date.now() - start,
      stages,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordProxyLog({
      level: "warn",
      source: "compressor",
      message: logMessage,
      metadata: { error: message },
    });
    return {
      output: input,
      usedFallback: true,
      durationMs: Date.now() - start,
      stages,
      error: message,
    };
  }
}

export async function compress(prompt: string): Promise<CompressResult> {
  const settings = getSettings();
  return runPipeline(
    settings,
    prompt,
    "compression failed, fallback to original prompt",
  );
}

/**
 * Apply compression globally to an entire CanonicalRequest (covers /v1/chat/completions,
 * /v1/messages, /v1/responses, and Model Combos):
 *  1) Compresses eligible messages (string or multi-part text arrays) per `scope` & `min_chars`.
 *  2) Injects Caveman Output Voice directive into system prompt when `caveman_voice !== "off"`.
 */
export async function compressCanonicalRequest(
  canonical: CanonicalRequest,
): Promise<{
  applied: boolean;
  messagesCompressed: number;
  savedChars: number;
  durationMs: number;
  voiceInjected: boolean;
}> {
  const settings = getSettings();
  const runInputPipeline = settings.rtk_enabled || settings.caveman_enabled;
  const voiceDirective =
    settings.caveman_voice !== "off"
      ? CAVEMAN_VOICE_DIRECTIVES[settings.caveman_voice]
      : null;

  if (!runInputPipeline && !voiceDirective) {
    return {
      applied: false,
      messagesCompressed: 0,
      savedChars: 0,
      durationMs: 0,
      voiceInjected: false,
    };
  }

  let messagesCompressed = 0;
  let totalSaved = 0;
  let totalMs = 0;
  let anyFallback = false;

  if (runInputPipeline && canonical.messages.length > 0) {
    const targetIndices = new Set<number>();
    const lastIdx = canonical.messages.length - 1;

    if (settings.scope === "last_only") {
      const lastRole = canonical.messages[lastIdx]?.role;
      if (lastRole === "user" || lastRole === "tool") targetIndices.add(lastIdx);
    } else if (settings.scope === "tool_and_last") {
      let lastUserIdx = -1;
      for (let i = 0; i < canonical.messages.length; i++) {
        const role = canonical.messages[i]!.role;
        if (role === "tool") targetIndices.add(i);
        if (role === "user") lastUserIdx = i;
      }
      if (lastUserIdx !== -1) targetIndices.add(lastUserIdx);
      else if (canonical.messages[lastIdx]?.role === "tool") {
        targetIndices.add(lastIdx);
      }
    } else {
      // all_messages
      for (let i = 0; i < canonical.messages.length; i++) {
        const role = canonical.messages[i]!.role;
        if (role === "user" || role === "tool") targetIndices.add(i);
      }
    }

    type CompressionTask =
      | {
          kind: "string";
          msg: (typeof canonical.messages)[number];
          text: string;
        }
      | {
          kind: "part";
          msg: (typeof canonical.messages)[number];
          part: { type: "text"; text: string };
          text: string;
        };

    const tasks: CompressionTask[] = [];
    for (const idx of targetIndices) {
      const msg = canonical.messages[idx]!;
      if (typeof msg.content === "string") {
        if (msg.content.length >= settings.min_chars) {
          tasks.push({ kind: "string", msg, text: msg.content });
        }
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text" && part.text.length >= settings.min_chars) {
            tasks.push({ kind: "part", msg, part, text: part.text });
          }
        }
      }
    }

    if (tasks.length > 0) {
      const limit = createLimiter(4);
      const results = await Promise.all(
        tasks.map((task) =>
          limit(() =>
            runPipeline(
              settings,
              task.text,
              task.kind === "string"
                ? "global compression failed, fallback to original message"
                : "global compression failed, fallback to original text block",
            ),
          ),
        ),
      );
      const changedMessages = new Set<object>();
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i]!;
        const r = results[i]!;
        totalMs += r.durationMs;
        if (r.usedFallback) anyFallback = true;
        if (!r.usedFallback && r.output !== task.text) {
          totalSaved += Math.max(0, task.text.length - r.output.length);
          if (task.kind === "string") {
            task.msg.content = r.output;
          } else {
            task.part.text = r.output;
          }
          changedMessages.add(task.msg);
        }
      }
      messagesCompressed = changedMessages.size;
    }

    if (messagesCompressed > 0 || anyFallback) {
      recordProxyLog({
        level: "info",
        source: "compressor",
        message: anyFallback
          ? "global compression partially fell back to original prompt"
          : `compressed ${messagesCompressed} message(s), saved ${totalSaved} chars`,
        metadata: {
          scope: settings.scope,
          messagesCompressed,
          savedChars: totalSaved,
          durationMs: totalMs,
        },
      });
    }
  }

  let voiceInjected = false;
  if (voiceDirective) {
    const sysIdx = canonical.messages.findIndex((m) => m.role === "system");
    if (sysIdx !== -1) {
      const sys = canonical.messages[sysIdx]!;
      if (typeof sys.content === "string") {
        if (!sys.content.includes(voiceDirective)) {
          sys.content = sys.content.trim()
            ? `${sys.content.trimEnd()}\n\n${voiceDirective}`
            : voiceDirective;
          voiceInjected = true;
        }
      } else if (Array.isArray(sys.content)) {
        const already = sys.content.some(
          (p) => p.type === "text" && p.text.includes(voiceDirective),
        );
        if (!already) {
          sys.content.push({ type: "text", text: `\n\n${voiceDirective}` });
          voiceInjected = true;
        }
      }
    } else {
      canonical.messages.unshift({ role: "system", content: voiceDirective });
      voiceInjected = true;
    }
  }

  return {
    applied: messagesCompressed > 0 || voiceInjected,
    messagesCompressed,
    savedChars: totalSaved,
    durationMs: totalMs,
    voiceInjected,
  };
}

export async function testCompression(
  sample: string,
): Promise<TestCompressionResult> {
  const settings = getSettings();
  const res = await runPipeline(
    settings,
    sample,
    "compression test failed, fallback to original prompt",
  );
  const inputChars = sample.length;
  const outputChars = res.output.length;
  const voiceDirective =
    settings.caveman_voice !== "off"
      ? CAVEMAN_VOICE_DIRECTIVES[settings.caveman_voice]
      : null;
  return {
    ...res,
    settings,
    inputChars,
    outputChars,
    savedChars: Math.max(0, inputChars - outputChars),
    savedPct: pctSaved(inputChars, outputChars),
    voiceDirective,
  };
}
