import { describe, it, expect } from "vitest";
import { highlightToHtml, languageForPath, escapeHtml } from "./highlight.js";

describe("highlightToHtml", () => {
  it("wraps keywords, strings, comments, and numbers in token spans (ts)", () => {
    const html = highlightToHtml(`const x = 42; // note`, "typescript");
    expect(html).toContain('<span class="tok-kw">const</span>');
    expect(html).toContain('<span class="tok-num">42</span>');
    expect(html).toContain('<span class="tok-com">// note</span>');
  });

  it("highlights python keywords and strings", () => {
    const html = highlightToHtml(`def f():\n    return "hi"`, "python");
    expect(html).toContain('<span class="tok-kw">def</span>');
    expect(html).toContain('<span class="tok-kw">return</span>');
    expect(html).toContain('<span class="tok-str">"hi"</span>');
  });

  it("escapes HTML in code (no raw < or &)", () => {
    const html = highlightToHtml(`const a = b < c && d;`, "typescript");
    expect(html).not.toContain("<c");
    expect(html).toContain("&lt;");
    expect(html).toContain("&amp;&amp;");
  });

  it("returns escaped plaintext with no token spans for unknown languages", () => {
    const html = highlightToHtml(`func main() { x := 1 }`, "other");
    expect(html).not.toContain("tok-");
    expect(html).toBe(escapeHtml(`func main() { x := 1 }`));
  });

  it("does not treat a keyword substring inside an identifier as a keyword", () => {
    const html = highlightToHtml(`constant returnValue`, "typescript");
    expect(html).not.toContain("tok-kw");
  });
});

describe("languageForPath", () => {
  it("maps known extensions", () => {
    expect(languageForPath("a/b.ts")).toBe("typescript");
    expect(languageForPath("a/b.tsx")).toBe("typescript");
    expect(languageForPath("x.jsx")).toBe("javascript");
    expect(languageForPath("s.py")).toBe("python");
  });
  it("falls back to other for unknown extensions", () => {
    expect(languageForPath("main.go")).toBe("other");
    expect(languageForPath("README")).toBe("other");
  });
});
