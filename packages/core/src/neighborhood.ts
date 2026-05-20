import type { Invariant, Note, SymbolRef } from "@invariance/gps-schemas";
import type { QueryContext } from "./query.js";
import { calleesOf } from "./query.js";
import { loadNotes, rankNotes } from "./notes.js";
import { loadInvariants, invariantsFor } from "./invariants.js";

export interface NeighborEntry {
  symbol: SymbolRef;
  depth: number;
  notes: Note[];
  invariants: Invariant[];
}

/**
 * Walk callees up to `depth` hops and gather per-symbol notes/invariants.
 * Depth-tier filter keeps the result bounded:
 *   depth 1: full notes (top 3) + invariants
 *   depth 2: top 2 notes + invariants
 *   depth 3+: invariants only
 */
export async function neighborhood(
  ctx: QueryContext,
  origin: SymbolRef,
  depth: number,
): Promise<NeighborEntry[]> {
  if (depth <= 1) return [];
  const seen = new Set<string>([keyOf(origin)]);
  let frontier: SymbolRef[] = [origin];
  const entries: NeighborEntry[] = [];
  const allInvariants = await loadInvariants(ctx.root);

  for (let d = 1; d < depth; d++) {
    const next: SymbolRef[] = [];
    for (const cur of frontier) {
      for (const callee of calleesOf(cur, ctx)) {
        const k = keyOf(callee);
        if (seen.has(k)) continue;
        seen.add(k);
        next.push(callee);
      }
    }
    const noteLimit = d === 1 ? 3 : d === 2 ? 2 : 0;
    for (const sym of next) {
      const symbolKey = sym.qualified_name ?? sym.name;
      const notesAll = noteLimit > 0 ? await loadNotes(ctx.root, sym.name) : [];
      const notes = rankNotes(notesAll, noteLimit);
      const invariants = invariantsFor(symbolKey, allInvariants);
      if (notes.length === 0 && invariants.length === 0) continue;
      entries.push({ symbol: sym, depth: d + 1, notes, invariants });
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return entries;
}

function keyOf(s: SymbolRef): string {
  return s.id ?? s.qualified_name ?? s.name;
}
