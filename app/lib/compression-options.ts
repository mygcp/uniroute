export const RTK_FILTERS = [
  { value: "auto", label: "Auto-detect (rtk pipe)" },
  { value: "log", label: "Application logs (-f log)" },
  { value: "git-diff", label: "Git diff (-f git-diff)" },
  { value: "git-log", label: "Git log (-f git-log)" },
  { value: "git-status", label: "Git status (-f git-status)" },
  { value: "vitest", label: "Vitest output (-f vitest)" },
  { value: "pytest", label: "Pytest output (-f pytest)" },
  { value: "cargo-test", label: "Cargo test (-f cargo-test)" },
  { value: "go-test", label: "Go test (-f go-test)" },
  { value: "go-build", label: "Go build (-f go-build)" },
  { value: "ctest", label: "CTest output (-f ctest)" },
  { value: "tsc", label: "TypeScript errors (-f tsc)" },
  { value: "grep", label: "Grep / ripgrep (-f grep)" },
  { value: "find", label: "Find / file list (-f find)" },
  { value: "mypy", label: "Mypy errors (-f mypy)" },
  { value: "ruff-check", label: "Ruff check (-f ruff-check)" },
  { value: "ruff-format", label: "Ruff format (-f ruff-format)" },
  { value: "sqlfluff-lint", label: "SQLFluff lint (-f sqlfluff-lint)" },
  { value: "prettier", label: "Prettier output (-f prettier)" },
  { value: "phpunit", label: "PHPUnit output (-f phpunit)" },
  { value: "pest", label: "Pest / ParaTest (-f pest)" },
  { value: "ecs", label: "PHP ECS (-f ecs)" },
  { value: "phpstan", label: "PHPStan (-f phpstan)" },
  { value: "pint", label: "Laravel Pint (-f pint)" },
] as const;

export const CAVEMAN_TYPES = [
  { value: "auto", label: "Auto-detect (all 16 compressors)" },
  { value: "json", label: "JSON payload (--type json)" },
  { value: "log", label: "Application logs (--type log)" },
  { value: "test-report", label: "Test reports (--type test-report)" },
  { value: "code", label: "Source code (--type code)" },
  { value: "diff", label: "Unified diff (--type diff)" },
  { value: "search-result", label: "Search / grep results (--type search-result)" },
  { value: "text", label: "Plain text (--type text)" },
  { value: "html", label: "HTML document (--type html)" },
  { value: "tabular", label: "Tables / CSV (--type tabular)" },
  { value: "config", label: "Config files (--type config)" },
  { value: "terminal", label: "Terminal output (--type terminal)" },
  { value: "toon", label: "TOON structured data (--type toon)" },
  { value: "a11y", label: "Accessibility tree (--type a11y)" },
] as const;

export const CAVEMAN_VOICES = [
  { value: "off", label: "Off (normal model verbosity)" },
  {
    value: "caveman",
    label: "Caveman (concise, drop filler, ~40-60% fewer output tokens)",
  },
  {
    value: "ultracave",
    label: "UltraCave (telegraphic fragments, high output savings)",
  },
  {
    value: "megacave",
    label: "MegaCave (maximum density, code/paths stay verbatim)",
  },
] as const;

export type CavemanVoice = (typeof CAVEMAN_VOICES)[number]["value"];

export const COMPRESSION_SCOPES = [
  {
    value: "tool_and_last",
    label: "Tool outputs + latest user message (Recommended)",
  },
  { value: "all_messages", label: "All user & tool messages in conversation" },
  { value: "last_only", label: "Latest message only" },
] as const;

export type CompressionScope = (typeof COMPRESSION_SCOPES)[number]["value"];

export const VALID_RTK_FILTERS = new Set<string>(RTK_FILTERS.map((f) => f.value));
export const VALID_CAVEMAN_TYPES = new Set<string>(
  CAVEMAN_TYPES.map((t) => t.value),
);
export const VALID_CAVEMAN_VOICES = new Set<string>(
  CAVEMAN_VOICES.map((v) => v.value),
);
export const VALID_COMPRESSION_SCOPES = new Set<string>(
  COMPRESSION_SCOPES.map((s) => s.value),
);

export const CAVEMAN_VOICE_DIRECTIVES: Record<Exclude<CavemanVoice, "off">, string> = {
  caveman:
    "[Caveman Mode] Answer terse and direct. Drop filler, greetings, and repetition. Use short active sentences (`[thing] [action] [reason]`). Preserve code, commands, flags, file paths, numbers, and error text verbatim. Switch to normal prose for critical security warnings or irreversible actions.",
  ultracave:
    "[UltraCave Mode] Telegraphic fragments only. No articles, filler, or pleasantries. Lead with answer/fix, then minimal next step. Keep all code blocks, identifiers, file paths, CLI flags, and errors byte-exact. Drop terse style only for destructive/security warnings.",
  megacave:
    "[MegaCave Mode] Maximum token density: ultra-compact fragments/symbols for prose, zero preamble or recap. Preserve all code, commands, paths, numbers, and error outputs verbatim. Revert to full prose for critical safety warnings.",
};
