import { onDbReset } from "./db";
import { getCachedSetting, setCachedSetting } from "./settings-cache";
import { extractMessageTextAll, type CanonicalRequest } from "./translate/canonical";
import {
  DEFAULT_PROMPT_GUARD_SETTINGS,
  DEFAULT_SYSTEM_GUARD_PROMPT,
  type PromptGuardCategory,
  type PromptGuardEvaluation,
  type PromptGuardMatch,
  type PromptGuardSettings,
} from "../lib/prompt-guard-options";

const SETTING_KEY = "prompt_guard_settings";
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
const WHITESPACE_RE = /\s+/g;

let cachedSettings: PromptGuardSettings | null = null;
onDbReset(() => {
  cachedSettings = null;
});

type RuleSpec = {
  category: PromptGuardCategory;
  rule: string;
  pattern: RegExp;
};

const RULES: RuleSpec[] = [
  {
    category: "prompt_injection",
    rule: "ignore_previous_instructions",
    pattern: /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|system|developer)\b[^.\n]{0,30}\b(?:instructions?|rules?|prompts?|directives?|constraints?)\b/i,
  },
  {
    category: "prompt_injection",
    rule: "new_system_role",
    pattern: /\b(?:you are now|from now on act as|enter|switch to)\b[^.\n]{0,35}\b(?:developer mode|admin mode|unrestricted|god mode|root shell)\b/i,
  },
  {
    category: "prompt_injection",
    rule: "stop_following_rules",
    pattern: /\b(?:do not|don't|never)\b[^.\n]{0,25}\b(?:follow|obey|respect)\b[^.\n]{0,30}\b(?:your rules|safety|guidelines|instructions)\b/i,
  },
  {
    category: "jailbreak",
    rule: "dan_persona",
    pattern: /\b(?:do anything now|jailbreak(?:ed| mode)?|evilbot|aim mode|stan mode|dude mode|no ethical boundaries)\b/i,
  },
  {
    category: "jailbreak",
    rule: "pretend_no_restrictions",
    pattern: /\b(?:pretend|act as if|suppose|hypothetically)\b[^.\n]{0,45}\b(?:no rules|no restrictions|no filters|no limitations|no safeguards)\b/i,
  },
  {
    category: "system_extraction",
    rule: "reveal_system_prompt",
    pattern: /\b(?:reveal|show|print|repeat|output|display|dump|leak|tell me)\b[^.\n]{0,40}\b(?:your|the|exact|verbatim|initial|original|hidden)\b[^.\n]{0,30}\b(?:system prompt|system message|developer prompt|instructions|secret rules)\b/i,
  },
  {
    category: "system_extraction",
    rule: "above_text_verbatim",
    pattern: /\b(?:repeat|copy|quote|output)\b[^.\n]{0,30}\b(?:everything above|all text above|word for word)\b/i,
  },
  {
    category: "delimiter_spoofing",
    rule: "chat_control_tokens",
    pattern: /(?:<\|im_start\|>|<\|im_end\|>|<\|system\|>|<\|assistant\|>|<<SYS>>|<\/SYS>|\[INST\]|\[\/INST\]|###\s*(?:SYSTEM|INSTRUCTION):)/i,
  },
  {
    category: "delimiter_spoofing",
    rule: "spoofed_system_block",
    pattern: /(?:^|\n)\s*(?:SYSTEM|DEVELOPER)\s*(?:OVERRIDE|PROMPT|INSTRUCTIONS)\s*:/i,
  },
  {
    category: "harmful_illegal",
    rule: "malware_or_ransomware",
    pattern: /\b(?:write|create|build|generate|code)\b[^.\n]{0,40}\b(?:ransomware|keylogger|trojan|rootkit|credential stealer|botnet|zero[- ]day exploit)\b/i,
  },
  {
    category: "harmful_illegal",
    rule: "illegal_weapons_or_fraud",
    pattern: /\b(?:how to|instructions to|step by step|guide to)\b[^.\n]{0,40}\b(?:build a bomb|make explosives|synthesize sarin|carding tutorial|phishing kit|ddos attack script)\b/i,
  },
  {
    category: "pii_secrets",
    rule: "private_key_block",
    pattern: /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY-----/,
  },
  {
    category: "pii_secrets",
    rule: "credential_prefix",
    pattern: /\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,})\b/,
  },
];

function cloneDefault(): PromptGuardSettings {
  return {
    ...DEFAULT_PROMPT_GUARD_SETTINGS,
    categories: { ...DEFAULT_PROMPT_GUARD_SETTINGS.categories },
    custom_blocked_terms: [...DEFAULT_PROMPT_GUARD_SETTINGS.custom_blocked_terms],
  };
}

export function normalizePromptGuardSettings(raw: Partial<PromptGuardSettings> | null | undefined): PromptGuardSettings {
  const base = cloneDefault();
  if (!raw || typeof raw !== "object") return base;

  const mode = raw.mode === "log_only" ? "log_only" : "block";
  const scope = raw.scope === "all" ? "all" : "user_and_tool";
  const categories = { ...base.categories };
  if (raw.categories && typeof raw.categories === "object") {
    for (const k of Object.keys(categories) as PromptGuardCategory[]) {
      if (typeof raw.categories[k] === "boolean") {
        categories[k] = raw.categories[k];
      }
    }
  }
  const customTerms = Array.isArray(raw.custom_blocked_terms)
    ? raw.custom_blocked_terms
        .map((t) => String(t).trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, 200)
    : base.custom_blocked_terms;

  const prompt =
    typeof raw.system_guard_prompt === "string" && raw.system_guard_prompt.trim()
      ? raw.system_guard_prompt.trim().slice(0, 4000)
      : DEFAULT_SYSTEM_GUARD_PROMPT;

  return {
    enabled: raw.enabled === true,
    mode,
    scope,
    check_media: raw.check_media !== false,
    inject_system_guard: raw.inject_system_guard === true,
    system_guard_prompt: prompt,
    categories,
    custom_blocked_terms: customTerms,
  };
}

export function getPromptGuardSettings(): PromptGuardSettings {
  if (cachedSettings) return cachedSettings;
  const rawJson = getCachedSetting(SETTING_KEY);
  if (!rawJson) {
    cachedSettings = cloneDefault();
    return cachedSettings;
  }
  try {
    cachedSettings = normalizePromptGuardSettings(JSON.parse(rawJson) as Partial<PromptGuardSettings>);
  } catch {
    cachedSettings = cloneDefault();
  }
  return cachedSettings;
}

export function savePromptGuardSettings(
  patch: Partial<PromptGuardSettings>,
): PromptGuardSettings {
  const current = getPromptGuardSettings();
  const next = normalizePromptGuardSettings({
    ...current,
    ...patch,
    categories: {
      ...current.categories,
      ...(patch.categories ?? {}),
    },
  });
  setCachedSetting(SETTING_KEY, JSON.stringify(next));
  cachedSettings = next;
  return next;
}

function normalizeText(input: string): string {
  return input.replace(ZERO_WIDTH_RE, "").replace(WHITESPACE_RE, " ").trim();
}

function makeExcerpt(text: string, index: number, len: number): string {
  const start = Math.max(0, index - 16);
  const end = Math.min(text.length, index + len + 24);
  return text.slice(start, end).slice(0, 96);
}

function scanText(
  text: string,
  role: string,
  settings: PromptGuardSettings,
  out: PromptGuardMatch[],
): void {
  if (!text) return;
  const normalized = normalizeText(text);
  if (!normalized) return;

  for (const spec of RULES) {
    if (!settings.categories[spec.category]) continue;
    const match = spec.pattern.exec(normalized);
    if (match) {
      out.push({
        category: spec.category,
        rule: spec.rule,
        role,
        excerpt: makeExcerpt(normalized, match.index, match[0].length),
      });
    }
  }

  if (settings.custom_blocked_terms.length > 0) {
    const lower = normalized.toLowerCase();
    for (const term of settings.custom_blocked_terms) {
      const needle = term.toLowerCase();
      if (!needle) continue;
      const idx = lower.indexOf(needle);
      if (idx !== -1) {
        out.push({
          category: "custom_term",
          rule: term,
          role,
          excerpt: makeExcerpt(normalized, idx, term.length),
        });
      }
    }
  }
}

export function evaluateTextPromptGuard(
  text: string,
  override?: PromptGuardSettings,
): PromptGuardEvaluation {
  const settings = override ?? getPromptGuardSettings();
  if (!settings.enabled) {
    return { allowed: true, blocked: false, injected: false, matches: [] };
  }

  const matches: PromptGuardMatch[] = [];
  scanText(text, "user", settings, matches);

  const blocked = matches.length > 0 && settings.mode === "block";
  return {
    allowed: !blocked,
    blocked,
    injected: false,
    matches,
    reason: matches[0] ? `${matches[0].category}:${matches[0].rule}` : undefined,
  };
}

export function evaluateCanonicalPromptGuard(
  canonical: CanonicalRequest,
  override?: PromptGuardSettings,
): PromptGuardEvaluation {
  const settings = override ?? getPromptGuardSettings();
  if (!settings.enabled) {
    return { allowed: true, blocked: false, injected: false, matches: [] };
  }

  const matches: PromptGuardMatch[] = [];
  for (const msg of canonical.messages) {
    if (
      settings.scope === "user_and_tool" &&
      msg.role !== "user" &&
      msg.role !== "tool"
    ) {
      continue;
    }
    const text = extractMessageTextAll(msg);
    if (text) scanText(text, msg.role, settings, matches);
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        if (tc.function.arguments) {
          scanText(tc.function.arguments, msg.role, settings, matches);
        }
      }
    }
  }

  const blocked = matches.length > 0 && settings.mode === "block";
  let injected = false;
  if (!blocked && settings.inject_system_guard && settings.system_guard_prompt.trim()) {
    const guardPrompt = settings.system_guard_prompt.trim();
    const alreadyPresent = canonical.messages.some(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.includes(guardPrompt),
    );
    if (!alreadyPresent) {
      canonical.messages = [{ role: "system", content: guardPrompt }, ...canonical.messages];
      injected = true;
    }
  }

  return {
    allowed: !blocked,
    blocked,
    injected,
    matches,
    reason: matches[0] ? `${matches[0].category}:${matches[0].rule}` : undefined,
  };
}

export function testPromptGuard(
  sample: string,
  override?: Partial<PromptGuardSettings>,
): PromptGuardEvaluation & { settings: PromptGuardSettings } {
  const base = getPromptGuardSettings();
  const effective = normalizePromptGuardSettings({
    ...base,
    ...(override ?? {}),
    enabled: true,
    categories: {
      ...base.categories,
      ...(override?.categories ?? {}),
    },
  });
  const req: CanonicalRequest = {
    model: "test",
    messages: [{ role: "user", content: sample }],
    stream: false,
    extra: {},
  };
  const result = evaluateCanonicalPromptGuard(req, effective);
  return { ...result, settings: effective };
}
