import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";

let registered = false;
function ensure(): void {
  if (registered) return;
  registered = true;
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("sh", bash);
  hljs.registerLanguage("shell", bash);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("js", javascript);
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("ts", typescript);
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("tsx", typescript);
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("py", python);
  hljs.registerLanguage("html", xml);
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("sql", sql);
  hljs.registerLanguage("yaml", yaml);
  hljs.registerLanguage("yml", yaml);
  hljs.registerLanguage("diff", diff);
  hljs.registerLanguage("go", go);
  hljs.registerLanguage("rust", rust);
}

const ALIAS: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  html: "xml",
  yml: "yaml",
  rs: "rust",
};

/** Highlight kode fence markdown; fallback escape otomatis dari hljs. */
export function highlightCode(
  code: string,
  lang?: string,
): { html: string; language: string | null } {
  ensure();
  const raw = (lang ?? "").toLowerCase();
  const language = raw ? (ALIAS[raw] ?? (hljs.getLanguage(raw) ? raw : null)) : null;
  try {
    if (language) {
      const out = hljs.highlight(code, { language, ignoreIllegals: true });
      return { html: out.value, language };
    }
    const auto = hljs.highlightAuto(code, [
      "javascript",
      "typescript",
      "json",
      "bash",
      "python",
    ]);
    return { html: auto.value, language: auto.language ?? null };
  } catch {
    return { html: "", language: null };
  }
}
