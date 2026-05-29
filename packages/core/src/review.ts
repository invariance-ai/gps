import { loadAllNotes } from "./notes.js";
import { loadAllQuestions, filterByStatus } from "./questions.js";
import { findPromotionCandidates, type PromotionCandidate } from "./promote.js";
import { findStale, type StaleEntry } from "./stale.js";

export type ReviewQueueAction =
  | {
      tool: "promotion_candidates";
      args: {
        symbol: string;
      };
    }
  | {
      tool: "find_stale";
      args: {
        days: number;
      };
    }
  | {
      tool: "questions_for";
      args: {
        symbol: string;
        status: "unresolved";
      };
    };

export interface ReviewQueueItem {
  kind: "promote" | "stale" | "open_question";
  priority: "high" | "medium" | "low";
  symbol: string;
  age_days?: number;
  reason: string;
  command: string;
  action: ReviewQueueAction;
}

export interface ReviewQueue {
  promote: PromotionCandidate[];
  stale: StaleEntry[];
  open_questions: { id: string; symbol: string; question: string; age_days: number }[];
  items: ReviewQueueItem[];
  total: number;
}

export async function buildReviewQueue(root: string, opts: { days?: number; limit?: number } = {}): Promise<ReviewQueue> {
  const limit = opts.limit ?? 50;
  const days = opts.days ?? 90;

  const notes = await loadAllNotes(root);
  const symbols = [...new Set(notes.map((n) => n.symbol))];
  const promote: PromotionCandidate[] = [];
  for (const sym of symbols) {
    const c = await findPromotionCandidates(root, sym);
    promote.push(...c);
    if (promote.length >= limit) break;
  }

  const stale = (await findStale(root, { days })).slice(0, limit);

  const allQuestions = await loadAllQuestions(root);
  const open = filterByStatus(allQuestions, "unresolved");
  const open_questions = open
    .map((q) => ({
      id: q.id,
      symbol: q.symbol,
      question: q.question,
      age_days: Math.floor((Date.now() - Date.parse(q.recorded_at)) / 86_400_000),
    }))
    .sort((a, b) => b.age_days - a.age_days)
    .slice(0, limit);

  return {
    promote,
    stale,
    open_questions,
    items: reviewItems(promote, stale, open_questions, days, limit),
    total: promote.length + stale.length + open_questions.length,
  };
}

function reviewItems(
  promote: PromotionCandidate[],
  stale: StaleEntry[],
  openQuestions: ReviewQueue["open_questions"],
  days: number,
  limit: number,
): ReviewQueueItem[] {
  const items: ReviewQueueItem[] = [];
  for (const p of promote) {
    items.push({
      kind: "promote",
      priority: p.severity_hint === "block" ? "high" : p.severity_hint === "warn" ? "medium" : "low",
      symbol: p.symbol,
      reason: `${p.notes.length} similar notes can be promoted: ${p.representative_lesson}`,
      command: `gps promote ${shellQuote(p.symbol)}`,
      action: {
        tool: "promotion_candidates",
        args: { symbol: p.symbol },
      },
    });
  }
  for (const s of stale) {
    items.push({
      kind: "stale",
      priority: s.file_changed_since ? "medium" : "low",
      symbol: s.symbol,
      age_days: s.age_days,
      reason: `${s.kind} is ${s.age_days}d old${s.file_changed_since ? " and its file changed since it was recorded" : ""}: ${s.text}`,
      command: `gps stale --days ${days}`,
      action: {
        tool: "find_stale",
        args: { days },
      },
    });
  }
  for (const q of openQuestions) {
    items.push({
      kind: "open_question",
      priority: q.age_days >= days ? "high" : q.age_days >= Math.ceil(days / 3) ? "medium" : "low",
      symbol: q.symbol,
      age_days: q.age_days,
      reason: `unresolved question is ${q.age_days}d old: ${q.question}`,
      command: `gps questions ${shellQuote(q.symbol)} --status unresolved`,
      action: {
        tool: "questions_for",
        args: { symbol: q.symbol, status: "unresolved" },
      },
    });
  }
  return items
    .sort(
      (a, b) =>
        priorityRank(b.priority) - priorityRank(a.priority) ||
        (b.age_days ?? 0) - (a.age_days ?? 0) ||
        a.symbol.localeCompare(b.symbol) ||
        a.kind.localeCompare(b.kind),
    )
    .slice(0, limit);
}

function priorityRank(priority: ReviewQueueItem["priority"]): number {
  return priority === "high" ? 2 : priority === "medium" ? 1 : 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
