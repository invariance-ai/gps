import { loadAllDecisions } from "./decisions.js";
import { loadInbox } from "./inbox.js";
import { loadInvariants } from "./invariants.js";
import { memorySuggestionsForDiff } from "./memory_suggestions.js";
import {
  loadAllAreaNotes,
  loadAllFeatureNotes,
  loadAllFileNotes,
  loadAllNotes,
} from "./notes.js";
import { loadPreferences } from "./preferences.js";
import { pruneNotes } from "./prune.js";
import { buildReviewQueue, type ReviewQueueItem } from "./review.js";
import { validateKnowledge } from "./validate_knowledge.js";

export interface MemoryHealthOptions {
  days?: number;
  limit?: number;
  base?: string;
  includeDiff?: boolean;
}

export interface MemoryHealthCounts {
  symbol_notes: number;
  scoped_notes: number;
  decisions: number;
  invariants: number;
  preferences: number;
  inbox_pending: number;
  review_items: number;
  validation_issues: number;
  prunable: number;
  diff_suggestions: number;
}

export type MemoryHealthAction =
  | { tool: "review_memory"; args: { days: number; limit: number } }
  | { tool: "validate_knowledge"; args: Record<string, never> }
  | { tool: "prune"; args: { days: number; dry_run: boolean } }
  | { tool: "memory_suggestions"; args: { base: string; limit: number } };

export interface MemoryHealthRecommendation {
  kind: "review_memory" | "validate_knowledge" | "prune" | "memory_suggestions";
  priority: "high" | "medium" | "low";
  reason: string;
  command: string;
  action: MemoryHealthAction;
}

export interface MemoryHealthResult {
  status: "healthy" | "watch" | "needs_attention";
  score: number;
  counts: MemoryHealthCounts;
  recommendations: MemoryHealthRecommendation[];
  review_items: ReviewQueueItem[];
}

export async function memoryHealth(
  root: string,
  opts: MemoryHealthOptions = {},
): Promise<MemoryHealthResult> {
  const days = opts.days ?? 90;
  const limit = opts.limit ?? 10;
  const base = opts.base ?? "HEAD";
  const [
    symbolNotes,
    fileNotes,
    featureNotes,
    areaNotes,
    decisions,
    invariants,
    preferences,
    inbox,
    review,
    validation,
    prunable,
    diffSuggestions,
  ] = await Promise.all([
    loadAllNotes(root),
    loadAllFileNotes(root),
    loadAllFeatureNotes(root),
    loadAllAreaNotes(root),
    loadAllDecisions(root),
    loadInvariants(root),
    loadPreferences(root),
    loadInbox(root),
    buildReviewQueue(root, { days, limit }),
    validateKnowledge(root),
    pruneNotes(root, { days, dryRun: true }),
    opts.includeDiff === false
      ? Promise.resolve(undefined)
      : memorySuggestionsForDiff(root, { base, limit }).catch(() => undefined),
  ]);

  const scoped_notes =
    fileNotes.reduce((sum, item) => sum + item.notes.length, 0) +
    featureNotes.reduce((sum, item) => sum + item.notes.length, 0) +
    areaNotes.reduce((sum, item) => sum + item.notes.length, 0);
  const inbox_pending = inbox.filter((item) => item.status === "pending").length;
  const counts: MemoryHealthCounts = {
    symbol_notes: symbolNotes.length,
    scoped_notes,
    decisions: decisions.length,
    invariants: invariants.length,
    preferences: preferences.length,
    inbox_pending,
    review_items: review.total,
    validation_issues: validation.issues.length,
    prunable: prunable.removed,
    diff_suggestions: diffSuggestions?.suggestions.length ?? 0,
  };
  const score = healthScore(counts);
  return {
    status: score >= 0.95 ? "healthy" : score >= 0.65 ? "watch" : "needs_attention",
    score,
    counts,
    recommendations: healthRecommendations(counts, days, limit, base),
    review_items: review.items,
  };
}

function healthScore(counts: MemoryHealthCounts): number {
  const reviewPenalty = Math.min(0.25, counts.review_items * 0.025);
  const validationPenalty = Math.min(0.25, counts.validation_issues * 0.03);
  const inboxPenalty = Math.min(0.15, counts.inbox_pending * 0.02);
  const prunePenalty = Math.min(0.15, counts.prunable * 0.02);
  const diffPenalty = Math.min(0.2, counts.diff_suggestions * 0.025);
  const activeMemory =
    counts.symbol_notes +
    counts.scoped_notes +
    counts.decisions +
    counts.invariants +
    counts.preferences;
  const coverageBonus = Math.min(0.1, activeMemory * 0.002);
  return clamp(1 - reviewPenalty - validationPenalty - inboxPenalty - prunePenalty - diffPenalty + coverageBonus);
}

function healthRecommendations(
  counts: MemoryHealthCounts,
  days: number,
  limit: number,
  base: string,
): MemoryHealthRecommendation[] {
  const out: MemoryHealthRecommendation[] = [];
  if (counts.review_items > 0) {
    out.push({
      kind: "review_memory",
      priority: counts.review_items >= 10 ? "high" : "medium",
      reason: `${counts.review_items} memory review item(s) need attention`,
      command: `gps review-memory --days ${days} --limit ${limit}`,
      action: { tool: "review_memory", args: { days, limit } },
    });
  }
  if (counts.validation_issues > 0) {
    out.push({
      kind: "validate_knowledge",
      priority: counts.validation_issues >= 10 ? "high" : "medium",
      reason: `${counts.validation_issues} knowledge anchor/expiry issue(s) found`,
      command: "gps validate-knowledge",
      action: { tool: "validate_knowledge", args: {} },
    });
  }
  if (counts.prunable > 0) {
    out.push({
      kind: "prune",
      priority: counts.prunable >= 10 ? "medium" : "low",
      reason: `${counts.prunable} stale low-confidence memory item(s) can be pruned`,
      command: `gps prune --days ${days} --dry-run`,
      action: { tool: "prune", args: { days, dry_run: true } },
    });
  }
  if (counts.diff_suggestions > 0) {
    out.push({
      kind: "memory_suggestions",
      priority: counts.diff_suggestions >= 5 ? "medium" : "low",
      reason: `${counts.diff_suggestions} changed-symbol memory suggestion(s) are open`,
      command: `gps memory-suggestions --base ${base}`,
      action: { tool: "memory_suggestions", args: { base, limit } },
    });
  }
  return out
    .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || a.kind.localeCompare(b.kind))
    .slice(0, limit);
}

function priorityRank(priority: MemoryHealthRecommendation["priority"]): number {
  return priority === "high" ? 2 : priority === "medium" ? 1 : 0;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}
