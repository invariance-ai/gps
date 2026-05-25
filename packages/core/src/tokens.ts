/**
 * Identifier tokenizer for semantic symbol search.
 *
 * `gps find` historically matched only symbol names, so searching for what a
 * symbol *does* ("backoff") missed the symbol that implements it
 * (`#calculateDelay`, which clamps `backoffLimit`). At index time we extract a
 * small, deduped token set from each symbol's source slice — identifiers split
 * on camelCase / snake_case, plus words from comments and signatures — so the
 * search scorer can match on body/doc tokens as a secondary signal.
 *
 * Tokens are bounded (length + count caps) to keep the JSON index small; this
 * is a recall aid, not a full-text index.
 */

/** Programming-language noise that carries no search signal. Lowercased. */
const STOP = new Set([
  "the", "and", "for", "this", "self", "new", "return", "const", "let", "var",
  "function", "async", "await", "yield", "import", "export", "from", "default",
  "class", "interface", "type", "enum", "extends", "implements", "public",
  "private", "protected", "static", "readonly", "void", "null", "undefined",
  "true", "false", "number", "string", "boolean", "object", "any", "unknown",
  "never", "throw", "catch", "try", "finally", "else", "case", "switch",
  "while", "break", "continue", "typeof", "instanceof", "def", "pass", "elif",
  "with", "not", "value", "result", "options", "option", "args",
]);

/** Max input characters scanned per symbol (bounds cost on huge functions). */
const MAX_INPUT_CHARS = 4000;
/** Max distinct tokens stored per symbol (bounds index growth). */
const DEFAULT_CAP = 50;

/**
 * Split an identifier into lowercased word parts on camelCase, ACRONYMCase, and
 * snake/kebab boundaries. `backoffLimit` → ["backoff","limit"], `HTTPError` →
 * ["http","error"], `retry_count` → ["retry","count"].
 */
export function splitIdentifier(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
}

/**
 * Extract a deduped, bounded token set from a chunk of source text. Order is
 * insertion order (first-seen wins) so the cap keeps the earliest/most-relevant
 * tokens (signature + leading comment come first in a symbol slice).
 */
export function extractTokens(text: string, cap = DEFAULT_CAP): string[] {
  const out = new Set<string>();
  const scan = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
  const words = scan.match(/[A-Za-z][A-Za-z0-9_$]*/g);
  if (!words) return [];
  for (const word of words) {
    for (const part of splitIdentifier(word)) {
      if (part.length <= 2 || STOP.has(part)) continue;
      out.add(part);
      if (out.size >= cap) return [...out];
    }
  }
  return [...out];
}
