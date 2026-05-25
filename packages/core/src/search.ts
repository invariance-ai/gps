/**
 * Symbol search scoring. Previously inline in the `find` CLI command and
 * name-only; extracted here so it can be unit-tested and so the token-based
 * (semantic) tier can be added below the name tiers.
 *
 * Ranking, highest first:
 *   100 qualified-name exact      85 qualified-name prefix   65 qualified substring
 *    95 name exact                80 name prefix             60 name substring
 *   ── name tiers always outrank semantic tiers ──
 *    50 query is one of the symbol's body/doc tokens
 *    48 every query token present in the symbol's tokens
 *  30+  some query tokens present (scaled by fraction)
 *    35 query is a substring of some token
 *
 * Semantic matches cap at 50 so a name match always wins — `find "retry"`
 * surfaces the symbol *named* retry before symbols that merely mention it.
 */
import type { SymbolRef } from "@invariance/gps-schemas";
import type { GpsIndex } from "./index_store.js";
import { extractTokens } from "./tokens.js";

export type MatchReason = "qualified" | "name" | "tokens";

export interface SearchMatch {
  symbol: SymbolRef;
  score: number;
  match_reason: MatchReason;
}

/** Score one symbol against a query, or null if it doesn't match at all. */
export function scoreSymbol(
  s: SymbolRef,
  query: string,
): { score: number; match_reason: MatchReason } | null {
  const q = query.toLowerCase().trim();
  if (!q) return null;

  const name = s.name.toLowerCase();
  const qualified = s.qualified_name?.toLowerCase();

  if (qualified === q) return { score: 100, match_reason: "qualified" };
  if (name === q) return { score: 95, match_reason: "name" };
  if (qualified?.startsWith(q)) return { score: 85, match_reason: "qualified" };
  if (name.startsWith(q)) return { score: 80, match_reason: "name" };
  if (qualified?.includes(q)) return { score: 65, match_reason: "qualified" };
  if (name.includes(q)) return { score: 60, match_reason: "name" };

  // tokens is stored space-joined in the index (compactness); split back out.
  const tokens = s.tokens ? s.tokens.split(" ") : undefined;
  if (tokens && tokens.length) {
    if (tokens.includes(q)) return { score: 50, match_reason: "tokens" };
    const qTokens = extractTokens(q);
    if (qTokens.length) {
      const present = qTokens.filter((t) => tokens.includes(t)).length;
      if (present === qTokens.length) return { score: 48, match_reason: "tokens" };
      if (present > 0) {
        return { score: 30 + Math.round((18 * present) / qTokens.length), match_reason: "tokens" };
      }
    }
    if (tokens.some((t) => t.includes(q))) return { score: 35, match_reason: "tokens" };
  }

  return null;
}

/**
 * Rank all symbols in the index against a query. Ties break toward the shorter
 * symbol name (more likely the thing you meant) for deterministic output.
 */
export function searchSymbols(index: GpsIndex, query: string, limit = 20): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const symbol of index.symbols) {
    const scored = scoreSymbol(symbol, query);
    if (scored) matches.push({ symbol, score: scored.score, match_reason: scored.match_reason });
  }
  matches.sort((a, b) => b.score - a.score || a.symbol.name.length - b.symbol.name.length);
  return matches.slice(0, limit);
}
