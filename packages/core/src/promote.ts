import type { Note } from "@invariance/gps-schemas";
import { loadNotes } from "./notes.js";

/**
 * Rule-based promotion: if ≥ minOccurrences notes for the same symbol share
 * substantial overlap (Jaccard > 0.4 on tokenized lesson), they're a
 * candidate for invariant promotion.
 *
 * v0.3 surfaces candidates; the user confirms before writing to invariants.yml.
 * LLM-assisted clustering (better recall on paraphrases) lands in v0.4.
 */

export interface PromotionCandidate {
  symbol: string;
  representative_lesson: string;
  notes: Note[];
  severity_hint: "info" | "warn" | "block";
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for",
  "with", "is", "are", "was", "were", "be", "been", "being", "this", "that",
  "it", "its", "as", "at", "by", "from", "must", "should", "always", "never",
]);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9_ ]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

const SEV_RANK: Record<"low" | "medium" | "high", number> = { low: 0, medium: 1, high: 2 };
const TO_INVARIANT: Record<"low" | "medium" | "high", "info" | "warn" | "block"> = {
  low: "info",
  medium: "warn",
  high: "block",
};

export async function findPromotionCandidates(
  root: string,
  symbol: string,
  minOccurrences = 3,
  threshold = 0.4,
): Promise<PromotionCandidate[]> {
  const notes = (await loadNotes(root, symbol)).filter((n) => !n.promoted);
  if (notes.length < minOccurrences) return [];

  const tokenSets = notes.map((n) => tokens(n.lesson));
  const visited = new Set<number>();
  const candidates: PromotionCandidate[] = [];

  for (let i = 0; i < notes.length; i++) {
    if (visited.has(i)) continue;
    const cluster: number[] = [i];
    for (let j = i + 1; j < notes.length; j++) {
      if (visited.has(j)) continue;
      if (jaccard(tokenSets[i]!, tokenSets[j]!) >= threshold) {
        cluster.push(j);
      }
    }
    if (cluster.length >= minOccurrences) {
      for (const idx of cluster) visited.add(idx);
      const clusterNotes = cluster.map((c) => notes[c]!);
      const maxSev = clusterNotes.reduce(
        (m, n) => (SEV_RANK[n.severity] > SEV_RANK[m] ? n.severity : m),
        clusterNotes[0]!.severity,
      );
      candidates.push({
        symbol,
        representative_lesson: notes[i]!.lesson,
        notes: clusterNotes,
        severity_hint: TO_INVARIANT[maxSev],
      });
    }
  }
  return candidates;
}
