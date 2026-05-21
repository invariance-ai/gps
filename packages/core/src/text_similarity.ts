/**
 * Shared lexical-similarity helpers. Used to cluster paraphrased notes
 * (promote.ts) and to fold reworded recurrences of the same lesson onto one
 * pending counter (lesson_pending.ts) so they graduate to invariants/global
 * rules instead of fragmenting across near-duplicate ids.
 */

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for",
  "with", "is", "are", "was", "were", "be", "been", "being", "this", "that",
  "it", "its", "as", "at", "by", "from", "must", "should", "always", "never",
]);

export function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9_ ]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
