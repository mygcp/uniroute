import { useMemo, useRef } from "react";
import { renderMarkdown } from "../lib/markdown";
import { highlightCode } from "../lib/highlight";
import { copyText } from "../lib/clipboard";

function injectCopyHeaders(html: string): string {
  let idx = 0;
  return html.replace(
    /<pre class="md-pre" data-lang="([^"]*)">/g,
    (_m, lang: string) => {
      const i = idx++;
      const label = lang || "code";
      return (
        `<pre class="md-pre" data-lang="${label}">` +
        `<div class="md-copybar" data-md-copybar="${i}">` +
        `<span class="md-copybar-lang">${label}</span>` +
        `<button type="button" class="md-copybar-btn" data-md-copy-btn="${i}" aria-label="Copy code">Copy</button>` +
        `</div>`
      );
    },
  );
}

/** Render LLM markdown (input is escaped first) with syntax highlighting. */
export function Markdown({ text, highlight = true }: { text: string; highlight?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const html = useMemo(
    () =>
      injectCopyHeaders(
        renderMarkdown(
          text,
          // Skip highlight.js while streaming; render escaped <pre> and highlight once done.
          highlight
            ? {
                highlight: (code, lang) => highlightCode(code, lang).html,
              }
            : undefined,
        ),
      ),
    [text, highlight],
  );

  const onClick = (e: React.MouseEvent) => {
    const btn = (e.target as HTMLElement).closest("[data-md-copy-btn]");
    if (!btn || !(btn instanceof HTMLButtonElement)) return;
    const pre = btn.closest("pre.md-pre");
    const code = pre?.querySelector("code")?.textContent ?? "";
    void copyText(code.replace(/\n$/, "")).then((ok) => {
      if (!ok) return;
      btn.textContent = "Copied";
      if (timerRef.current != null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (btn.isConnected) btn.textContent = "Copy";
      }, 1500);
    });
  };

  return (
    <div
      ref={ref}
      className="md-body min-w-0"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
