import { createHash } from "node:crypto";
import type { Invariant, PromoteMode } from "@invariance/gps-schemas";
import { findPromotionCandidates } from "./promote.js";
import { appendInvariants } from "./invariants.js";
import { loadAllNotes, markSymbolNotesPromoted } from "./notes.js";
import { matchedRiskTopics, type RiskTopic } from "./risk_topics.js";

export interface AutoPromoted {
  invariant: Invariant;
  from_notes: number;
}

export interface SkippedRisk {
  symbol: string;
  representative_lesson: string;
  topics: RiskTopic[];
}

export interface AutoPromoteResult {
  policy: PromoteMode;
  promoted: AutoPromoted[];
  skipped_risk: SkippedRisk[];
}

export interface AutoPromoteOpts {
  /** Restrict to these symbols; defaults to every symbol with notes. */
  symbols?: string[];
  /** Compute the plan without writing invariants or flipping notes. */
  dryRun?: boolean;
}

/** Stable invariant name so re-runs dedupe cleanly (append is name-keyed). */
function invariantName(symbol: string, lesson: string): string {
  const h = createHash("sha1").update(lesson.trim().toLowerCase()).digest("hex").slice(0, 8);
  return `auto: ${symbol} — ${h}`;
}

/**
 * Auto-graduate recurring note clusters into invariants, governed by policy:
 *
 *   never — no-op (manual `gps promote <symbol>` only; current behavior).
 *   safe  — promote clusters EXCEPT those touching a require_approval_for risk
 *           topic (auth/payments/…), which are held back for human review.
 *   all   — promote every cluster, bypassing the risk gate.
 *
 * Promoted source notes are flipped `promoted=true` so they stop re-clustering.
 * Idempotent: invariants dedupe by name, so a second run adds nothing new.
 */
export async function autoPromote(
  root: string,
  policy: PromoteMode,
  opts: AutoPromoteOpts = {},
): Promise<AutoPromoteResult> {
  const result: AutoPromoteResult = { policy, promoted: [], skipped_risk: [] };
  if (policy === "never") return result;

  const symbols =
    opts.symbols ?? [...new Set((await loadAllNotes(root)).map((n) => n.symbol))];

  const invariantsToAdd: Invariant[] = [];
  // symbol → set of lesson texts whose notes should be flipped promoted=true
  const lessonsBySymbol = new Map<string, Set<string>>();

  for (const symbol of symbols) {
    const candidates = await findPromotionCandidates(root, symbol);
    for (const c of candidates) {
      const corpus = [c.representative_lesson, ...c.notes.map((n) => n.lesson)].join(" ");
      const topics = matchedRiskTopics(corpus);
      if (policy === "safe" && topics.length > 0) {
        result.skipped_risk.push({
          symbol,
          representative_lesson: c.representative_lesson,
          topics,
        });
        continue;
      }
      const invariant: Invariant = {
        name: invariantName(symbol, c.representative_lesson),
        applies_to: [symbol],
        rule: c.representative_lesson,
        evidence: c.notes
          .map((n) => n.evidence_link)
          .filter((e): e is string => typeof e === "string" && e.length > 0),
        severity: c.severity_hint,
      };
      invariantsToAdd.push(invariant);
      result.promoted.push({ invariant, from_notes: c.notes.length });
      const lessons = lessonsBySymbol.get(symbol) ?? new Set<string>();
      for (const n of c.notes) lessons.add(n.lesson);
      lessonsBySymbol.set(symbol, lessons);
    }
  }

  if (opts.dryRun) return result;

  if (invariantsToAdd.length > 0) {
    await appendInvariants(root, invariantsToAdd);
    for (const [symbol, lessons] of lessonsBySymbol) {
      await markSymbolNotesPromoted(root, symbol, lessons);
    }
  }
  return result;
}
