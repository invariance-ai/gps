import { loadDecisions, loadAllDecisions } from "./decisions.js";
import type { Decision } from "@invariance/gps-schemas";

const STOP = new Set([
  "the","a","an","and","or","but","of","to","in","on","for","with","is","are","was","were",
  "be","been","being","this","that","it","its","as","at","by","from","must","should",
  "always","never","not","do","does","make","makes","made",
]);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9_ ]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 3 && !STOP.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface RejectedConflict {
  symbol: string;
  proposed: string;
  rejected_alternative: string;
  prior_decision: string;
  rationale?: string;
  recorded_at: string;
  similarity: number;
}

export interface FindRejectedOpts {
  symbol?: string;
  threshold?: number;
  limit?: number;
}

/**
 * Find prior decisions whose `rejected_alternative` overlaps strongly with the
 * proposed text — i.e. we've already decided against this approach.
 */
export async function findRejectedConflicts(
  root: string,
  proposed: string,
  opts: FindRejectedOpts = {},
): Promise<RejectedConflict[]> {
  const threshold = opts.threshold ?? 0.25;
  const limit = opts.limit ?? 5;
  const decisions: Decision[] = opts.symbol
    ? await loadDecisions(root, opts.symbol)
    : await loadAllDecisions(root);

  const propTokens = tokens(proposed);
  const out: RejectedConflict[] = [];

  for (const d of decisions) {
    if (!d.rejected_alternative) continue;
    const sim = jaccard(propTokens, tokens(d.rejected_alternative));
    if (sim < threshold) continue;
    out.push({
      symbol: d.symbol,
      proposed,
      rejected_alternative: d.rejected_alternative,
      prior_decision: d.decision,
      rationale: d.rationale,
      recorded_at: d.recorded_at,
      similarity: Math.round(sim * 100) / 100,
    });
  }
  return out.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}
