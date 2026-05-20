import { loadDecisions } from "./decisions.js";
import { loadNotes } from "./notes.js";
import { loadInvariants, invariantsFor } from "./invariants.js";
import type { Decision, Invariant, Note } from "@invariance/gps-schemas";

export type ConflictKind = "contradicts" | "supersedes" | "stale";

export interface Conflict {
  kind: ConflictKind;
  symbol: string;
  lhs: { type: "invariant" | "decision" | "note"; id: string; text: string; at?: string };
  rhs: { type: "invariant" | "decision" | "note"; id: string; text: string; at?: string };
  summary: string;
}

const NUMERIC_RE = /\$?\b\d{1,3}(?:[,_]?\d{3})*(?:\.\d+)?%?\b/g;

function extractNumbers(text: string): string[] {
  return [...text.matchAll(NUMERIC_RE)].map((m) => m[0]);
}

function shareTopic(a: string, b: string): boolean {
  const stop = new Set([
    "the","a","an","is","are","be","of","to","for","with","and","or","at","in","on","by","under","over","than","from","this","that",
  ]);
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !stop.has(w)),
    );
  const wa = words(a);
  const wb = words(b);
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared >= 2;
}

export async function findConflicts(root: string, symbolKey: string): Promise<Conflict[]> {
  const [decisions, notes, allInvariants] = await Promise.all([
    loadDecisions(root, symbolKey),
    loadNotes(root, symbolKey),
    loadInvariants(root),
  ]);
  const invariants = invariantsFor(symbolKey, allInvariants);
  const out: Conflict[] = [];

  // 1. Invariant ↔ Decision numeric mismatch on same topic.
  for (const inv of invariants) {
    const invNums = extractNumbers(inv.rule);
    if (invNums.length === 0) continue;
    for (const d of decisions) {
      const dNums = extractNumbers(d.decision);
      if (dNums.length === 0) continue;
      if (!shareTopic(inv.rule, d.decision)) continue;
      const same = invNums.some((n) => dNums.includes(n));
      if (!same) {
        out.push({
          kind: "contradicts",
          symbol: symbolKey,
          lhs: { type: "invariant", id: inv.name, text: inv.rule },
          rhs: { type: "decision", id: d.decision.slice(0, 40), text: d.decision, at: d.recorded_at },
          summary: `numeric threshold differs (${invNums.join(",")} vs ${dNums.join(",")})`,
        });
      }
    }
  }

  // 2. Decision newer than overlapping-topic invariant — potential supersede.
  for (const d of decisions) {
    for (const inv of invariants) {
      if (!shareTopic(inv.rule, d.decision)) continue;
      // invariants don't carry timestamps yet — heuristic is just "decision exists & overlaps topic".
      out.push({
        kind: "supersedes",
        symbol: symbolKey,
        lhs: { type: "decision", id: d.decision.slice(0, 40), text: d.decision, at: d.recorded_at },
        rhs: { type: "invariant", id: inv.name, text: inv.rule },
        summary: `decision overlaps invariant topic; verify invariant still applies`,
      });
    }
  }

  // 3. Note severity high with invariant disagreement on topic.
  for (const n of notes) {
    if (n.severity !== "high") continue;
    for (const inv of invariants) {
      if (!shareTopic(inv.rule, n.lesson)) continue;
      const invNums = extractNumbers(inv.rule);
      const noteNums = extractNumbers(n.lesson);
      if (invNums.length > 0 && noteNums.length > 0 && !invNums.some((x) => noteNums.includes(x))) {
        out.push({
          kind: "contradicts",
          symbol: symbolKey,
          lhs: { type: "invariant", id: inv.name, text: inv.rule },
          rhs: { type: "note", id: n.recorded_at, text: n.lesson, at: n.recorded_at },
          summary: `high-severity note disagrees on numeric threshold`,
        });
      }
    }
  }

  return dedupe(out);
}

function dedupe(items: Conflict[]): Conflict[] {
  const seen = new Set<string>();
  const out: Conflict[] = [];
  for (const c of items) {
    const k = `${c.kind}|${c.lhs.text}|${c.rhs.text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

export type { Decision, Invariant, Note };
