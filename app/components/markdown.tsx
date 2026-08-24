import { renderMarkdown } from "../lib/markdown";
import { highlightCode } from "../lib/highlight";

/** Render markdown LLM (aman: input di-escape dulu) + syntax highlight. */
export function Markdown({ text }: { text: string }) {
  return (
    <div
      className="md-body min-w-0"
      dangerouslySetInnerHTML={{
        __html: renderMarkdown(text, {
          highlight: (code, lang) => highlightCode(code, lang).html,
        }),
      }}
    />
  );
}
