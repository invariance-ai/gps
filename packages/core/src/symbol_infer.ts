import type { SymbolRef } from "@invariance/gps-schemas";
import { readIndex, type GpsIndex } from "./index_store.js";
import { loadFeatures, matchFeaturesInPrompt } from "./features.js";
import { searchSymbols } from "./search.js";

const STOPWORDS = new Set([
  "TODO", "FIXME", "NOTE", "XXX", "HACK",
  "README", "CLAUDE", "PR", "MR", "API", "URL", "HTTP", "HTTPS",
  "JSON", "YAML", "TOML", "HTML", "CSS", "SQL",
]);

export interface SymbolMatch {
  symbol: SymbolRef;
  score: number;
  via: "exact" | "qualified" | "feature" | "fuzzy";
}

// Common English filler that should never count as a symbol candidate.
// Kept small — the score threshold filters noise, so this only needs to
// suppress words that *do* collide with common symbol names in the wild.
const LOWERCASE_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "these", "those",
  "when", "where", "what", "which", "while", "after", "before", "should", "would",
  "could", "must", "will", "shall", "have", "been", "make", "made", "does", "doing",
  "code", "file", "line", "data", "type", "object", "string", "number", "value",
  "function", "method", "class", "module", "import", "export", "return", "async",
  "await", "true", "false", "null", "undefined", "void",
  "add", "remove", "update", "change", "fix", "use", "using", "used", "call", "run",
  "test", "tests", "case", "cases", "feature", "support",
]);

function extractCandidates(text: string): string[] {
  const out = new Set<string>();
  const add = (tok: string | undefined): void => {
    if (tok) out.add(tok);
  };
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) {
    const inner = m[1];
    if (!inner) continue;
    for (const tok of inner.split(/[^A-Za-z0-9_.]+/)) add(tok);
  }
  for (const m of text.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*)\b/g)) add(m[1]);
  for (const m of text.matchAll(/\b([a-z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\b/g)) add(m[1]);
  for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){1,4})\b/g)) add(m[1]);
  // snake_case, leading-underscore, and UPPER_SNAKE identifiers (`_compute_loss`,
  // `run_training`, `__init__`, `MAX_RETRIES`). The lowercase/camelCase patterns
  // above all require a leading [a-z], so they miss leading underscores and
  // SCREAMING_SNAKE entirely — a real gap for Python and C-style codebases.
  for (const m of text.matchAll(/\b(_*[A-Za-z][A-Za-z0-9_]*)\b/g)) {
    const tok = m[1];
    if (tok && (tok.includes("_") || tok.startsWith("_"))) add(tok);
  }
  // Lowercase whole-word tokens (≥4 chars). Lets natural-language intents like
  // "add caching to refunds" match symbols `cache`, `refund`, `Refunds.cache`.
  // Filler is suppressed via LOWERCASE_STOPWORDS; remaining noise is filtered
  // by the scoreMatch threshold.
  for (const m of text.matchAll(/\b([a-z][a-z0-9_]{3,})\b/g)) {
    const tok = m[1];
    if (tok && !LOWERCASE_STOPWORDS.has(tok)) add(tok);
  }
  return Array.from(out).filter((t) => !STOPWORDS.has(t));
}

function scoreMatch(candidate: string, sym: SymbolRef): number {
  const cand = candidate.toLowerCase();
  const name = sym.name.toLowerCase();
  const qual = sym.qualified_name?.toLowerCase();
  if (qual === cand) return 100;
  if (name === cand) return 95;
  if (qual && qual.endsWith("." + cand)) return 85;
  if (qual?.startsWith(cand)) return 70;
  if (name.startsWith(cand)) return 65;
  return 0;
}

export interface InferOptions {
  limit?: number;
  minLen?: number;
  minScore?: number;
}

/** Cap on a fuzzy-fallback score: a guess from token overlap must never claim
 * the high confidence reserved for exact/prefix name matches. */
const FUZZY_SCORE_CAP = 60;

/**
 * Pure name-tier + fuzzy-fallback matching over an already-loaded index.
 *
 * Name tier: extract identifier-like candidates from the prompt and match them
 * against symbol names/qualified names (exact, suffix, prefix).
 *
 * Fuzzy fallback: when the name tier finds nothing, defer to the same matcher
 * `gps find` uses (`searchSymbols`), which splits camelCase/snake_case and
 * matches body/doc tokens. This is what makes a natural-language intent — and
 * Python snake_case / acronym names the name tier's regexes can't tokenize —
 * resolve to candidates instead of dead-ending. Fuzzy scores are capped below
 * the name tiers so an exact name match always ranks first.
 *
 * Split out from `inferSymbols` (which adds feature-alias matches from disk) so
 * the ranking is unit-testable without writing an index to a temp dir.
 */
export function inferSymbolMatches(
  index: GpsIndex,
  prompt: string,
  opts: InferOptions = {},
): SymbolMatch[] {
  const limit = opts.limit ?? 5;
  const minLen = opts.minLen ?? 4;
  const minScore = opts.minScore ?? 65;
  const matches = new Map<string, SymbolMatch>();

  const candidates = extractCandidates(prompt).filter((c) => c.length >= minLen);
  for (const cand of candidates) {
    let best: SymbolMatch | null = null;
    for (const sym of index.symbols) {
      const score = scoreMatch(cand, sym);
      if (score >= minScore && (!best || score > best.score)) {
        const via: SymbolMatch["via"] = score === 100 ? "qualified" : "exact";
        best = { symbol: sym, score, via };
      }
    }
    if (best) {
      const key = best.symbol.qualified_name ?? best.symbol.name;
      const prev = matches.get(key);
      if (!prev || best.score > prev.score) matches.set(key, best);
    }
  }

  if (matches.size === 0) {
    for (const m of searchSymbols(index, prompt, limit)) {
      const key = m.symbol.qualified_name ?? m.symbol.name;
      const score = Math.min(m.score, FUZZY_SCORE_CAP);
      const prev = matches.get(key);
      if (!prev || score > prev.score) matches.set(key, { symbol: m.symbol, score, via: "fuzzy" });
    }
  }

  return [...matches.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Infer candidate symbols from a natural-language prompt.
 * Returns top matches ranked by confidence (0-100).
 */
export async function inferSymbols(
  root: string,
  prompt: string,
  opts: InferOptions = {},
): Promise<SymbolMatch[]> {
  const limit = opts.limit ?? 5;

  let index;
  try {
    index = await readIndex(root);
  } catch {
    return [];
  }

  const matches = new Map<string, SymbolMatch>();

  // Feature-alias matches (read from .gps/features on disk).
  try {
    const featuresFile = await loadFeatures(root);
    const labels = matchFeaturesInPrompt(prompt, featuresFile.features);
    const byId = new Map<string, SymbolRef>();
    for (const s of index.symbols) if (s.id) byId.set(s.id, s);
    for (const label of labels) {
      const feature = featuresFile.features[label];
      if (!feature) continue;
      for (const fs of feature.symbols.slice(0, limit)) {
        const sym = byId.get(fs.id);
        if (!sym) continue;
        const key = sym.qualified_name ?? sym.name;
        const score = 90 + Math.round(fs.weight * 10);
        const prev = matches.get(key);
        if (!prev || score > prev.score) matches.set(key, { symbol: sym, score, via: "feature" });
      }
    }
  } catch {
    /* features unavailable */
  }

  // Name-tier + fuzzy matching over the index.
  for (const m of inferSymbolMatches(index, prompt, opts)) {
    const key = m.symbol.qualified_name ?? m.symbol.name;
    const prev = matches.get(key);
    if (!prev || m.score > prev.score) matches.set(key, m);
  }

  return [...matches.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
