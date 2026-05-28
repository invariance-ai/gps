/**
 * Cross-memory topic retrieval.
 *
 * Symbol search (search.ts) and context-from-prompt are *symbol-anchored*: you
 * must already know (or name) a symbol. `recallMemory` answers the orthogonal
 * question — "what does this repo's memory know about <topic>?" — by ranking
 * every memory artifact (notes, decisions, invariants, preferences, and global
 * lessons) against a free-text query.
 *
 * Dependency-free by design: it reuses the same identifier tokenizer
 * (`extractTokens`) the symbol scorer uses, applied to each artifact's text. No
 * embeddings — results stay deterministic and the index stays small, consistent
 * with the rest of gps. Scoring mirrors the tier philosophy of `search.ts`:
 * exact phrase > all query tokens present > fraction present > weak containment.
 */
import type { Note, Decision, Preference } from "@invariance/gps-schemas";
import { extractTokens } from "./tokens.js";
import {
  loadAllNotes,
  loadAllFileNotes,
  loadAllFeatureNotes,
  loadAllAreaNotes,
  filterExpiredNotes,
} from "./notes.js";
import { loadInvariants } from "./invariants.js";
import { loadAllDecisions, filterExpiredDecisions } from "./decisions.js";
import { loadPreferences } from "./preferences.js";
import { readGlobalLessons } from "./claude_md.js";

export type RecallKind = "note" | "decision" | "invariant" | "preference" | "lesson";

export interface RecallHit {
  kind: RecallKind;
  /** Displayable, also-scored content for this artifact. */
  text: string;
  /** Where it's anchored: symbol, scope:target, invariant targets, or topic. */
  anchor?: string;
  score: number;
  severity?: string;
  source?: string;
}

export interface RecallOptions {
  limit?: number;
  /** Restrict to a subset of artifact kinds. */
  kinds?: RecallKind[];
}

/** Query tokens are few; widen the cap for artifact text so long rules tokenize fully. */
const TEXT_TOKEN_CAP = 200;

/**
 * Score a free-text query against an artifact's text. Returns 0 for no match so
 * callers can drop it. Tiers (highest first): exact phrase substring (90),
 * every query token present (70), fraction of query tokens present (30..68),
 * weak token containment (28).
 */
export function scoreText(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  if (!q || !text) return 0;
  let score = 0;
  if (text.toLowerCase().includes(q)) score = 90;
  const qTokens = extractTokens(query);
  if (qTokens.length) {
    const textTokens = new Set(extractTokens(text, TEXT_TOKEN_CAP));
    const present = qTokens.filter((t) => textTokens.has(t)).length;
    if (present === qTokens.length) score = Math.max(score, 70);
    else if (present > 0) score = Math.max(score, 30 + Math.round((38 * present) / qTokens.length));
    else if ([...textTokens].some((t) => qTokens.some((qt) => t.includes(qt))))
      score = Math.max(score, 28);
  }
  return score;
}

// Severity nudges within a tier so blocking rules and high-severity lessons
// float above neutral ones at a similar relevance — mirrors rankNotes.
const NOTE_SEV_BOOST: Record<string, number> = { high: 8, medium: 0, low: -2 };
const INV_SEV_BOOST: Record<string, number> = { block: 10, warn: 4, info: 0 };

function noteText(n: Note): string {
  return n.evidence ? `${n.lesson} (${n.evidence})` : n.lesson;
}

function decisionText(d: Decision): string {
  const parts = [d.decision];
  if (d.rejected_alternative) parts.push(`rejected: ${d.rejected_alternative}`);
  if (d.rationale) parts.push(`because: ${d.rationale}`);
  return parts.join(" — ");
}

function prefText(p: Preference): string {
  return p.topic ? `${p.text} [${p.topic}]` : p.text;
}

/**
 * Rank all memory artifacts against `query`. Returns hits sorted by score
 * (ties broken toward shorter text, then kind, for deterministic output).
 */
export async function recallMemory(
  root: string,
  query: string,
  opts: RecallOptions = {},
): Promise<RecallHit[]> {
  const want = (k: RecallKind) => !opts.kinds || opts.kinds.includes(k);
  const hits: RecallHit[] = [];
  const consider = (hit: Omit<RecallHit, "score">, boost = 0) => {
    const base = scoreText(query, hit.text);
    if (base <= 0) return;
    hits.push({ ...hit, score: base + boost });
  };

  if (want("note")) {
    for (const n of filterExpiredNotes(await loadAllNotes(root))) {
      consider(
        { kind: "note", text: noteText(n), anchor: n.symbol, severity: n.severity, source: n.source },
        NOTE_SEV_BOOST[n.severity] ?? 0,
      );
    }
    const scopedGroups = [
      await loadAllFileNotes(root),
      await loadAllFeatureNotes(root),
      await loadAllAreaNotes(root),
    ];
    for (const group of scopedGroups) {
      for (const { target, notes } of group) {
        for (const n of filterExpiredNotes(notes)) {
          consider(
            {
              kind: "note",
              text: noteText(n),
              anchor: `${n.scope ?? "scope"}:${target}`,
              severity: n.severity,
              source: n.source,
            },
            NOTE_SEV_BOOST[n.severity] ?? 0,
          );
        }
      }
    }
  }

  if (want("decision")) {
    for (const d of filterExpiredDecisions(await loadAllDecisions(root))) {
      consider({ kind: "decision", text: decisionText(d), anchor: d.symbol, source: d.source });
    }
  }

  if (want("invariant")) {
    for (const inv of await loadInvariants(root)) {
      consider(
        {
          kind: "invariant",
          text: `${inv.name}: ${inv.rule}`,
          anchor: inv.applies_to.join(", "),
          severity: inv.severity,
        },
        INV_SEV_BOOST[inv.severity] ?? 0,
      );
    }
  }

  if (want("preference")) {
    for (const p of await loadPreferences(root)) {
      consider({ kind: "preference", text: prefText(p), anchor: p.topic, source: p.source });
    }
  }

  if (want("lesson")) {
    for (const l of await readGlobalLessons(root)) {
      consider({ kind: "lesson", text: l.lesson, severity: l.severity }, NOTE_SEV_BOOST[l.severity] ?? 0);
    }
  }

  hits.sort(
    (a, b) => b.score - a.score || a.text.length - b.text.length || a.kind.localeCompare(b.kind),
  );
  return hits.slice(0, opts.limit ?? 20);
}

/** Markdown line for one hit, used by the CLI renderer and packByBudget. */
export function formatRecallHit(h: RecallHit): string {
  const meta = [h.kind, h.anchor].filter(Boolean).join(" · ");
  return `- ${h.text} _(${meta})_`;
}
