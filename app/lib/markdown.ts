import { highlightCode } from "./highlight";

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function inline(md: string): string {
	let out = escapeHtml(md);
	out = out.replace(
		/`([^`\n]+)`/g,
		(_, c) => `<code class="md-code">${c}</code>`,
	);
	out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
	out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
	out = out.replace(
		/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
		'<a href="$2" target="_blank" rel="noreferrer" class="md-link">$1</a>',
	);
	return out;
}

export type MarkdownOptions = {
	/** Syntax highlight hook for fenced code blocks. Returns ready-to-render HTML. */
	highlight?: (code: string, lang?: string) => string;
};

export function renderMarkdown(
	src: string,
	opts?: MarkdownOptions,
): string {
	const lines = src.replace(/\r\n/g, "\n").split("\n");
	const html: string[] = [];
	let inCode = false;
	let codeLang = "";
	let codeBuf: string[] = [];
	let listType: "ul" | "ol" | null = null;

	const closeList = () => {
		if (listType) {
			html.push(`</${listType}>`);
			listType = null;
		}
	};

	for (const raw of lines) {
		const fence = raw.match(/^```(\w*)\s*$/);
		if (fence) {
			if (inCode) {
				const code = escapeHtml(codeBuf.join("\n"));
				const highlighted =
					opts?.highlight?.(code, codeLang || undefined) ?? code;
				html.push(
					`<pre class="md-pre" data-lang="${escapeHtml(codeLang)}"><code class="hljs">${highlighted}</code></pre>`,
				);
				codeBuf = [];
				inCode = false;
			} else {
				closeList();
				inCode = true;
				codeLang = fence[1] ?? "";
			}
			continue;
		}
		if (inCode) {
			codeBuf.push(raw);
			continue;
		}

		const heading = raw.match(/^(#{1,4})\s+(.*)$/);
		if (heading) {
			closeList();
			const level = Math.min(heading[1]!.length + 2, 6); // h3..h6
			html.push(`<h${level} class="md-h">${inline(heading[2]!)}</h${level}>`);
			continue;
		}

		const ul = raw.match(/^\s*[-*]\s+(.*)$/);
		const ol = raw.match(/^\s*\d+[.)]\s+(.*)$/);
		if (ul || ol) {
			const want = ul ? "ul" : "ol";
			if (listType !== want) {
				closeList();
				html.push(`<${want} class="md-list">`);
				listType = want;
			}
			html.push(`<li>${inline((ul ? ul[1] : ol![1]) ?? "")}</li>`);
			continue;
		}

		const quote = raw.match(/^>\s?(.*)$/);
		if (quote) {
			closeList();
			html.push(
				`<blockquote class="md-quote">${inline(quote[1] ?? "")}</blockquote>`,
			);
			continue;
		}

		if (raw.trim() === "") {
			closeList();
			continue;
		}

		closeList();
		html.push(`<p class="md-p">${inline(raw)}</p>`);
	}

	if (inCode) {
		const code = escapeHtml(codeBuf.join("\n"));
		const highlighted = opts?.highlight?.(code, codeLang || undefined) ?? code;
		html.push(
			`<pre class="md-pre" data-lang="${escapeHtml(codeLang)}"><code class="hljs">${highlighted}</code></pre>`,
		);
	}
	closeList();
	return html.join("\n");
}
