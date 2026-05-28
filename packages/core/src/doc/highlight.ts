import type { DocLanguage } from "@invariance/gps-schemas";

/**
 * Minimal, dependency-free syntax highlighter for the doc-store HTML output.
 *
 * Deliberately tiny: a single tokenizing pass classifying comments, strings,
 * numbers, and keywords (everything else is emitted as escaped plaintext). gps
 * avoids heavy deps, so we do not inline highlight.js or run tree-sitter at
 * render time — this covers the "IDE-esque but simple" bar for TS/JS/Python and
 * degrades gracefully (escaped plaintext) for any other language.
 *
 * Output is pre-highlighted server-side, so the generated HTML needs no client
 * JS to colorize. Every emitted token is HTML-escaped first.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const JS_KEYWORDS = new Set([
  "abstract", "any", "as", "async", "await", "boolean", "break", "case", "catch",
  "class", "const", "continue", "debugger", "declare", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "from", "function",
  "get", "if", "implements", "import", "in", "infer", "instanceof", "interface",
  "is", "keyof", "let", "namespace", "never", "new", "null", "number", "object",
  "of", "private", "protected", "public", "readonly", "return", "satisfies", "set",
  "static", "string", "super", "switch", "this", "throw", "true", "try", "type",
  "typeof", "undefined", "unknown", "var", "void", "while", "yield",
]);

const PY_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
  "del", "elif", "else", "except", "False", "finally", "for", "from", "global",
  "if", "import", "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass",
  "raise", "return", "True", "try", "while", "with", "yield", "self", "cls",
]);

interface Rule {
  type: "comment" | "string" | "number" | "ident" | "plain";
  re: string;
}

function rules(lang: DocLanguage): Rule[] {
  if (lang === "python") {
    return [
      { type: "comment", re: "#[^\\n]*" },
      { type: "string", re: "\"\"\"[\\s\\S]*?\"\"\"|'''[\\s\\S]*?'''|\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*'" },
      { type: "number", re: "\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b" },
      { type: "ident", re: "[A-Za-z_]\\w*" },
      { type: "plain", re: "[\\s\\S]" },
    ];
  }
  // typescript / javascript share lexical structure.
  return [
    { type: "comment", re: "//[^\\n]*|/\\*[\\s\\S]*?\\*/" },
    { type: "string", re: "`(?:\\\\.|[^`\\\\])*`|\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*'" },
    { type: "number", re: "\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b" },
    { type: "ident", re: "[A-Za-z_$][\\w$]*" },
    { type: "plain", re: "[\\s\\S]" },
  ];
}

const SPAN: Record<string, string> = {
  comment: "tok-com",
  string: "tok-str",
  number: "tok-num",
  keyword: "tok-kw",
};

/**
 * Highlight a code string to HTML. `lang === "other"` (or any unknown language)
 * returns escaped plaintext with no token spans.
 */
export function highlightToHtml(code: string, lang: DocLanguage): string {
  if (lang === "other") return escapeHtml(code);
  const rs = rules(lang);
  const kw = lang === "python" ? PY_KEYWORDS : JS_KEYWORDS;
  const scanner = new RegExp(rs.map((r) => `(${r.re})`).join("|"), "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = scanner.exec(code)) !== null) {
    // Find which alternation group matched (1-indexed into rs).
    let idx = -1;
    for (let i = 1; i <= rs.length; i++) {
      if (m[i] !== undefined) {
        idx = i - 1;
        break;
      }
    }
    if (idx < 0) {
      // Defensive: shouldn't happen because "plain" matches any char.
      out.push(escapeHtml(m[0]));
      continue;
    }
    const rule = rs[idx];
    if (!rule) {
      out.push(escapeHtml(m[0]));
      continue;
    }
    const tok = m[0];
    let type: string = rule.type;
    if (type === "ident" && kw.has(tok)) type = "keyword";
    const cls = SPAN[type];
    out.push(cls ? `<span class="${cls}">${escapeHtml(tok)}</span>` : escapeHtml(tok));
    // Guard against zero-length matches (cannot occur with these rules, but
    // keeps the loop safe if rules change).
    if (m.index === scanner.lastIndex) scanner.lastIndex++;
  }
  return out.join("");
}

const EXT_LANG: Record<string, DocLanguage> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
};

/** Map a file path to a highlightable language; unknown extensions → "other". */
export function languageForPath(p: string): DocLanguage {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? "other";
}
