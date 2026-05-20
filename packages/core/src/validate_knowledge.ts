import type { SymbolRef } from "@invariance/gps-schemas";
import { readIndex } from "./index_store.js";
import { loadAllNotes } from "./notes.js";
import { loadAllDecisions } from "./decisions.js";
import { loadInvariants } from "./invariants.js";

/**
 * Walk knowledge entries (notes, decisions, invariants) and flag the ones
 * that have drifted from the source they describe:
 *
 *   missing_anchor      — the symbol the entry points at no longer exists.
 *                         Includes a `suggested_anchor` if a near-match was found.
 *   expired             — entry past its `expires_at` date.
 *   invalid_expires_at  — entry's `expires_at` is not a parseable ISO date.
 *   no_anchor_id        — entry has no anchor_id (pre-v0.2 entry, or was authored
 *                         against a symbol that wasn't in the index at the time).
 *
 * Duplicate + contradiction detection are intentionally out of scope for
 * this first pass — they require deeper text analysis and are best authored
 * once anchor health is solid.
 */
export interface KnowledgeIssue {
  kind: "missing_anchor" | "expired" | "no_anchor_id" | "invalid_expires_at";
  source: "note" | "decision" | "invariant";
  entry: {
    /** Symbol field (legacy / human-readable label). */
    symbol?: string;
    /** Stable id, if present. */
    anchor_id?: string;
    /** Free-text summary of the entry — first 80 chars of the lesson/decision/rule. */
    summary: string;
  };
  /** When kind=missing_anchor, the closest symbol we could find. */
  suggested_anchor?: { symbol_id: string; qualified_name: string; file: string; score: number };
}

export interface ValidateKnowledgeReport {
  total: { notes: number; decisions: number; invariants: number };
  issues: KnowledgeIssue[];
}

export interface ValidateKnowledgeOptions {
  /** Suppress `no_anchor_id` findings (for legacy entries). */
  legacyOk?: boolean;
}

export async function validateKnowledge(
  root: string,
  options: ValidateKnowledgeOptions = {},
): Promise<ValidateKnowledgeReport> {
  const { legacyOk = false } = options;
  let symbols: SymbolRef[] = [];
  try {
    const idx = await readIndex(root);
    symbols = idx.symbols;
  } catch {
    // no index — validator returns "no anchor data" implicitly
  }
  const byName = new Map<string, SymbolRef[]>();
  for (const s of symbols) {
    const arr = byName.get(s.name) ?? [];
    arr.push(s);
    byName.set(s.name, arr);
    const qn = s.qualified_name;
    if (qn && qn !== s.name) {
      const a2 = byName.get(qn) ?? [];
      a2.push(s);
      byName.set(qn, a2);
    }
  }
  const idSet = new Set(symbols.map((s) => s.id).filter(Boolean) as string[]);

  const notes = await loadAllNotes(root);
  const decisions = await loadAllDecisions(root);
  const invariants = await loadInvariants(root);

  const issues: KnowledgeIssue[] = [];
  const now = Date.now();

  function checkExpiry(
    expiresAt: string | undefined,
    source: KnowledgeIssue["source"],
    entry: KnowledgeIssue["entry"],
  ): "expired" | "invalid" | "ok" {
    if (!expiresAt) return "ok";
    const d = new Date(expiresAt);
    const t = d.getTime();
    if (isNaN(t)) {
      issues.push({ kind: "invalid_expires_at", source, entry });
      return "invalid";
    }
    if (t < now) {
      issues.push({ kind: "expired", source, entry });
      return "expired";
    }
    return "ok";
  }

  for (const n of notes) {
    const summary = (n.lesson ?? "").slice(0, 80);
    const entry = { symbol: n.symbol, anchor_id: n.anchor_id, summary };
    const exp = checkExpiry(n.expires_at, "note", entry);
    if (exp !== "ok") continue;
    if (n.anchor_id) {
      // Stable-id anchored entries: live if the id is in the index OR the
      // legacy name still resolves (covers cases where the id changed format
      // but the symbol survives by name).
      const idHit = idSet.has(n.anchor_id);
      const nameHit = n.symbol ? byName.has(n.symbol) : false;
      if (!idHit && !nameHit) {
        issues.push({
          kind: "missing_anchor",
          source: "note",
          entry,
          suggested_anchor: suggestAnchor(n.symbol, byName),
        });
      }
    } else {
      // No stable anchor — fall back to name lookup; flag only if name has zero matches.
      if (n.symbol && !byName.has(n.symbol)) {
        issues.push({
          kind: "missing_anchor",
          source: "note",
          entry: { symbol: n.symbol, summary },
          suggested_anchor: suggestAnchor(n.symbol, byName),
        });
      } else if (n.symbol && symbols.length > 0 && !legacyOk) {
        // entry's anchor is intact but using legacy format
        issues.push({ kind: "no_anchor_id", source: "note", entry: { symbol: n.symbol, summary } });
      }
    }
  }

  for (const d of decisions) {
    const summary = (d.decision ?? "").slice(0, 80);
    const entry = { symbol: d.symbol, anchor_id: d.anchor_id, summary };
    const exp = checkExpiry(d.expires_at, "decision", entry);
    if (exp !== "ok") continue;
    if (d.anchor_id) {
      const idHit = idSet.has(d.anchor_id);
      const nameHit = d.symbol ? byName.has(d.symbol) : false;
      if (!idHit && !nameHit) {
        issues.push({
          kind: "missing_anchor",
          source: "decision",
          entry,
          suggested_anchor: suggestAnchor(d.symbol, byName),
        });
      }
    } else if (d.symbol && !byName.has(d.symbol)) {
      issues.push({
        kind: "missing_anchor",
        source: "decision",
        entry: { symbol: d.symbol, summary },
        suggested_anchor: suggestAnchor(d.symbol, byName),
      });
    } else if (!d.anchor_id && d.symbol && symbols.length > 0 && !legacyOk) {
      issues.push({ kind: "no_anchor_id", source: "decision", entry: { symbol: d.symbol, summary } });
    }
  }

  for (const inv of invariants) {
    const summary = (inv.rule ?? "").slice(0, 80);
    // Invariants use applies_to (multiple) not a single symbol/anchor.
    for (const t of inv.applies_to) {
      if (!t || t.includes("*") || t.includes("/")) continue; // skip globs + file patterns
      if (!byName.has(t)) {
        issues.push({
          kind: "missing_anchor",
          source: "invariant",
          entry: { symbol: t, summary: `[${inv.name}] ${summary}` },
          suggested_anchor: suggestAnchor(t, byName),
        });
      }
    }
  }

  return {
    total: { notes: notes.length, decisions: decisions.length, invariants: invariants.length },
    issues,
  };
}

/**
 * Levenshtein distance — small inline impl, no dep.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1,
        prev[j]! + 1,
        prev[j - 1]! + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

function suggestAnchor(
  needle: string | undefined,
  byName: Map<string, SymbolRef[]>,
): KnowledgeIssue["suggested_anchor"] {
  if (!needle) return undefined;
  const needleLow = needle.toLowerCase();
  let best: { sym: SymbolRef; score: number } | undefined;
  for (const [name, syms] of byName) {
    const low = name.toLowerCase();
    let score = 0;
    if (low === needleLow) {
      score = 100;
    } else {
      // Reject very short candidates unless identical — avoids
      // "create" being suggested for "createRefund".
      if (low.length < 4 || needleLow.length < 4) continue;
      const dist = levenshtein(low, needleLow);
      const maxLen = Math.max(low.length, needleLow.length);
      const sim = 1 - dist / maxLen;
      if (sim < 0.6) continue;
      score = Math.round(sim * 100);
    }
    const sym = syms[0]!;
    if (!best || score > best.score) best = { sym, score };
  }
  if (!best || !best.sym.id) return undefined;
  return {
    symbol_id: best.sym.id,
    qualified_name: best.sym.qualified_name ?? best.sym.name,
    file: best.sym.file,
    score: best.score,
  };
}
