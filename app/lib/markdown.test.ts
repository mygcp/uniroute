import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  test("escapes html", () => {
    const out = renderMarkdown('<script>alert("x")</script>');
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  test("fenced code + highlight hook", () => {
    const out = renderMarkdown(
      "```js\nconst a = 1;\n```",
      { highlight: (code, lang) => `HL[${lang}:${code}]` },
    );
    expect(out).toContain('class="hljs"');
    expect(out).toContain("HL[js:const a = 1;]");
  });

  test("inline code, bold, link, list", () => {
    const out = renderMarkdown(
      "**b** `c` [l](https://x.a)\n- i1\n- i2",
    );
    expect(out).toContain("<strong>b</strong>");
    expect(out).toContain('class="md-code">c<');
    expect(out).toContain('href="https://x.a"');
    expect((out.match(/<li>/g) ?? []).length).toBe(2);
  });
});
