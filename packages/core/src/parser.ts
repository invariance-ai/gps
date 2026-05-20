import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SymbolRef } from "@invariance/gps-schemas";

/**
 * v0.1 parser: regex-based extraction of declarations and call sites for
 * TypeScript/JavaScript and Python. tree-sitter (WASM) is planned for v0.2 —
 * shipped this way to keep `npm install -g @invariance/gps` zero-native-deps.
 *
 * Trade-off (honest): ~90% precision on typical code, lower on heavy macros,
 * decorators-as-factories, and dynamic dispatch. Good enough for v0.1 because
 * downstream consumers (CLI/MCP) can fall back to grep verification.
 *
 * Note on end_line: the regex parser only locates declaration lines — it
 * does not parse bodies, so `end_line` is left undefined. Downstream
 * (diff_to_symbols) treats absent end_line as a 1-line symbol, which is the
 * pre-v0.6a behavior: long functions touched mid-body via the regex parser
 * may still be missed by the hunk→symbol mapper. Tree-sitter (default) does
 * track end_line.
 */
export type ParsedLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "ruby"
  | "csharp";

export interface ImportBinding {
  /** Local name as visible inside this file. */
  local: string;
  /** Module specifier as written in source (e.g. "./refunds", "@app/foo"). */
  source: string;
  /** Imported name in the source module; undefined for namespace imports. */
  imported?: string;
  /** Kind of binding. "default" means the source module's default export. */
  kind: "named" | "default" | "namespace";
}

export interface ParsedFile {
  path: string;
  language: ParsedLanguage;
  symbols: SymbolRef[];
  call_sites: Array<{ callee_name: string; line: number; from: string }>;
  /** Import bindings observed in this file (TS/JS/Py only for v0.2). */
  imports?: ImportBinding[];
  /** Re-exports: names this file re-exports from other modules. */
  re_exports?: Array<{ local?: string; exported: string; source: string }>;
}

const TS_PATTERNS: Array<{ kind: SymbolRef["kind"]; re: RegExp }> = [
  { kind: "function", re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm },
  { kind: "function", re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm },
  { kind: "class", re: /^\s*(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][\w$]*)/gm },
  { kind: "type", re: /^\s*(?:export\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)/gm },
  { kind: "method", re: /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/gm },
];

const PY_PATTERNS: Array<{ kind: SymbolRef["kind"]; re: RegExp }> = [
  { kind: "function", re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/gm },
  { kind: "class", re: /^\s*class\s+([A-Za-z_][\w]*)/gm },
];

const GO_PATTERNS: Array<{ kind: SymbolRef["kind"]; re: RegExp }> = [
  { kind: "function", re: /^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)\s*\(/gm },
  { kind: "type", re: /^\s*type\s+([A-Za-z_][\w]*)\s+(?:struct|interface|=)/gm },
];

const RUST_PATTERNS: Array<{ kind: SymbolRef["kind"]; re: RegExp }> = [
  { kind: "function", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/gm },
  { kind: "type", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_][\w]*)/gm },
  { kind: "method", re: /^\s+(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/gm },
];

const JAVA_PATTERNS: Array<{ kind: SymbolRef["kind"]; re: RegExp }> = [
  { kind: "class", re: /^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|static\s+)*class\s+([A-Za-z_][\w]*)/gm },
  { kind: "type", re: /^\s*(?:public\s+|private\s+|protected\s+)*(?:interface|enum|@interface)\s+([A-Za-z_][\w]*)/gm },
  { kind: "method", re: /^\s+(?:public\s+|private\s+|protected\s+|static\s+|final\s+|synchronized\s+|abstract\s+)+(?:[A-Za-z_<>,\s\[\]?]+\s+)?([A-Za-z_][\w]*)\s*\([^)]*\)\s*(?:throws[^{]+)?\{/gm },
];

const RUBY_PATTERNS: Array<{ kind: SymbolRef["kind"]; re: RegExp }> = [
  { kind: "function", re: /^\s*def\s+(?:self\.)?([A-Za-z_][\w!?=]*)/gm },
  { kind: "class", re: /^\s*class\s+([A-Z][\w]*)/gm },
  { kind: "module", re: /^\s*module\s+([A-Z][\w]*)/gm },
];

const CS_PATTERNS: Array<{ kind: SymbolRef["kind"]; re: RegExp }> = [
  { kind: "class", re: /^\s*(?:public\s+|private\s+|internal\s+|protected\s+|abstract\s+|sealed\s+|static\s+|partial\s+)*class\s+([A-Za-z_][\w]*)/gm },
  { kind: "type", re: /^\s*(?:public\s+|private\s+|internal\s+|protected\s+)*(?:interface|struct|enum|record)\s+([A-Za-z_][\w]*)/gm },
  { kind: "method", re: /^\s+(?:public\s+|private\s+|internal\s+|protected\s+|static\s+|virtual\s+|override\s+|abstract\s+|async\s+|sealed\s+)+(?:[A-Za-z_<>,\s\[\]?]+\s+)?([A-Za-z_][\w]*)\s*\([^)]*\)\s*(?:where[^{]+)?\{/gm },
];

const LANGUAGE_BY_EXT: Record<string, ParsedLanguage> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".cs": "csharp",
};

const PATTERNS_BY_LANG: Record<ParsedLanguage, Array<{ kind: SymbolRef["kind"]; re: RegExp }>> = {
  typescript: TS_PATTERNS,
  javascript: TS_PATTERNS,
  python: PY_PATTERNS,
  go: GO_PATTERNS,
  rust: RUST_PATTERNS,
  java: JAVA_PATTERNS,
  ruby: RUBY_PATTERNS,
  csharp: CS_PATTERNS,
};

// Generic call-site detector: `name(` not preceded by . is a *new* call;
// `obj.name(` is a method call. Skip keywords.
const KEYWORDS = new Set([
  "if", "for", "while", "switch", "case", "return", "throw", "catch", "typeof",
  "new", "await", "yield", "import", "export", "function", "class", "def",
  "do", "else", "try", "finally", "with", "in", "is", "not", "and", "or",
  "print", "len", "str", "int", "float", "list", "dict", "set", "tuple",
  "range", "True", "False", "None", "console", "require", "Error", "Promise",
  "Array", "Object", "Map", "Set", "JSON", "Math", "Date", "Number", "Boolean",
  "String", "Symbol", "RegExp",
]);

export async function parseFile(filePath: string): Promise<ParsedFile> {
  if (process.env.GPS_PARSER !== "regex") {
    const ext = path.extname(filePath);
    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" ||
        ext === ".mjs" || ext === ".cjs" || ext === ".py") {
      try {
        const { parseFileTS } = await import("./parser_ts.js");
        return await parseFileTS(filePath);
      } catch (err) {
        if (process.env.GPS_PARSER === "tree-sitter") throw err;
        // best-effort fallback to regex; warn once per process, count the rest
        parserFallbackCount++;
        if (!warnedFallback) {
          warnedFallback = true;
          parserFallbackFirstError = (err as Error).message;
          console.error(`gps: tree-sitter parser unavailable (${parserFallbackFirstError}); falling back to regex. Set GPS_PARSER=regex to silence.`);
        }
      }
    }
  }
  return parseFileRegex(filePath);
}

let warnedFallback = false;
let parserFallbackCount = 0;
let parserFallbackFirstError: string | null = null;

/**
 * Log a one-line summary if tree-sitter ever fell back to regex during this
 * process. Callers (e.g. the `index` command) invoke this at end-of-run so
 * silent fallbacks don't hide a misconfigured install.
 */
/**
 * Hydrate the persistent tree-sitter parse cache for `root`. Cheap when already
 * loaded. No-op if the regex fallback path is active (GPS_PARSER=regex).
 */
export async function loadParseCache(root: string): Promise<void> {
  if (process.env.GPS_PARSER === "regex") return;
  try {
    const m = await import("./parser_ts.js");
    await m.loadParseCache(root);
  } catch {
    // tree-sitter unavailable — caching is moot
  }
}

/** Persist the tree-sitter parse cache for `root`. Non-fatal on failure. */
export async function saveParseCache(root: string): Promise<void> {
  if (process.env.GPS_PARSER === "regex") return;
  try {
    const m = await import("./parser_ts.js");
    await m.saveParseCache(root);
  } catch {
    // tree-sitter unavailable
  }
}

export function reportParserFallbacks(): { count: number; firstError: string | null } {
  if (parserFallbackCount > 1) {
    console.error(`gps: tree-sitter fell back to regex for ${parserFallbackCount} files this run.`);
  }
  return { count: parserFallbackCount, firstError: parserFallbackFirstError };
}

async function parseFileRegex(filePath: string): Promise<ParsedFile> {
  const src = await readFile(filePath, "utf8");
  const ext = path.extname(filePath);
  const language: ParsedFile["language"] = LANGUAGE_BY_EXT[ext] ?? "typescript";

  const patterns = PATTERNS_BY_LANG[language];
  const symbols: SymbolRef[] = [];
  const seen = new Set<string>();
  const classScopes: Array<{ name: string; line: number; indent: number }> = [];

  for (const { kind, re } of patterns) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      const name = m[1];
      if (!name || KEYWORDS.has(name)) continue;
      const line = src.slice(0, m.index).split("\n").length;
      const text = src.split("\n")[line - 1] ?? "";
      if (kind === "method" && /^\s*(?:export\s+)?(?:async\s+)?function\b/.test(text)) continue;
      if (kind === "method" && /^\s*(?:export\s+)?const\b/.test(text)) continue;
      const indent = leadingWhitespace(text);
      const container =
        kind === "method"
          ? nearestClass(classScopes, line, indent)?.name
          : undefined;
      const qualified_name = container ? `${container}.${name}` : name;
      const key = `${kind}:${qualified_name}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({ name, qualified_name, container, file: filePath, line, kind });
      if (kind === "class") classScopes.push({ name, line, indent });
    }
  }

  const call_sites: ParsedFile["call_sites"] = [];
  const callRe = /(?<![.\w])([A-Za-z_$][\w$]*)\s*\(/g;
  let containing = "<module>";
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Track containing symbol cheaply: last function/class/method declaration above
    for (const { re } of patterns) {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m && m[1]) containing = m[1];
    }
    for (const m of line.matchAll(callRe)) {
      const callee = m[1];
      if (!callee || KEYWORDS.has(callee)) continue;
      call_sites.push({ callee_name: callee, line: i + 1, from: containing });
    }
  }

  return { path: filePath, language, symbols, call_sites };
}

function leadingWhitespace(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function nearestClass(
  scopes: Array<{ name: string; line: number; indent: number }>,
  line: number,
  indent: number,
): { name: string; line: number; indent: number } | undefined {
  return scopes
    .filter((s) => s.line < line && s.indent < indent)
    .sort((a, b) => b.line - a.line)[0];
}

export const TS_GLOB = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"];
export const PY_GLOB = ["**/*.py"];
export const GO_GLOB = ["**/*.go"];
export const RUST_GLOB = ["**/*.rs"];
export const JAVA_GLOB = ["**/*.java"];
export const RUBY_GLOB = ["**/*.rb"];
export const CSHARP_GLOB = ["**/*.cs"];

export const ALL_SOURCE_GLOBS = [
  ...TS_GLOB,
  ...PY_GLOB,
  ...GO_GLOB,
  ...RUST_GLOB,
  ...JAVA_GLOB,
  ...RUBY_GLOB,
  ...CSHARP_GLOB,
];
