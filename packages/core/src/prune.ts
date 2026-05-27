import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { Decision, Note, type Decision as DecisionT, type Note as NoteT } from "@invariance/gps-schemas";
import { isDecisionExpired } from "./decisions.js";
import { isNoteExpired } from "./notes.js";
import { daysBetween } from "./time.js";

/**
 * Sources considered "trusted human" — notes from these sources are never pruned.
 */
const SAFE_NOTE_SOURCES = new Set<NoteT["source"]>(["human", "doc", "incident", "pr"]);
const SAFE_DECISION_SOURCES = new Set<DecisionT["source"]>(["human", "pr", "promoted"]);
const MAINTENANCE_REL = ".gps/maintenance/prune.json";

export interface PruneDetail {
  kind: "note" | "decision";
  symbol: string;
  text: string;
  reason: string;
  file: string;
}

export interface PruneReport {
  removed: number;
  dry_run: boolean;
  details: PruneDetail[];
}

export interface PruneOpts {
  days?: number;
  dryRun?: boolean;
  minConfidence?: number;
  auto?: boolean;
  intervalDays?: number;
}

/**
 * A note is prunable when ALL of the following hold:
 *   1. source is NOT in {human, doc, incident, pr}
 *   2. NOT promoted
 *   3. severity is NOT high
 *   4. Either:
 *      a. expires_at is in the past, OR
 *      b. last_surfaced_at is absent OR older than `days` days
 *         AND recorded_at is also older than `days` days
 *         (so a freshly-recorded but never-surfaced note has a grace period)
 */
function isPrunableNote(
  note: NoteT,
  days: number,
  minConfidence: number,
  now: Date = new Date(),
): { prunable: boolean; reason: string } {
  if (SAFE_NOTE_SOURCES.has(note.source)) return { prunable: false, reason: "" };
  if (note.verified_by) return { prunable: false, reason: "" };
  if (note.promoted) return { prunable: false, reason: "" };
  if (note.severity === "high") return { prunable: false, reason: "" };
  if ((note.confidence ?? note.classifier?.confidence ?? 0) >= minConfidence) return { prunable: false, reason: "" };

  // Expired notes are always prunable.
  if (isNoteExpired(note, now)) {
    return { prunable: true, reason: `expired (expires_at=${note.expires_at})` };
  }

  // Stale: never surfaced or last_surfaced_at older than `days`, AND recorded also old.
  const recordedAge = daysBetween(note.recorded_at, now);
  if (recordedAge < days) return { prunable: false, reason: "" }; // too young

  const surfacedAge = note.last_surfaced_at
    ? daysBetween(note.last_surfaced_at, now)
    : null;

  if (surfacedAge === null) {
    // Never surfaced, and recorded long ago.
    return { prunable: true, reason: `never surfaced (recorded ${recordedAge}d ago)` };
  }
  if (surfacedAge >= days) {
    return { prunable: true, reason: `last surfaced ${surfacedAge}d ago (threshold ${days}d)` };
  }
  return { prunable: false, reason: "" };
}

function isPrunableDecision(
  decision: DecisionT,
  days: number,
  minConfidence: number,
  now: Date = new Date(),
): { prunable: boolean; reason: string } {
  if (isDecisionExpired(decision, now)) {
    return { prunable: true, reason: `expired (expires_at=${decision.expires_at})` };
  }
  if (SAFE_DECISION_SOURCES.has(decision.source)) return { prunable: false, reason: "" };
  if (decision.verified_by) return { prunable: false, reason: "" };
  if ((decision.confidence ?? 0) >= minConfidence) return { prunable: false, reason: "" };

  const recordedAge = daysBetween(decision.recorded_at, now);
  if (recordedAge < days) return { prunable: false, reason: "" };
  const surfacedAge = decision.last_surfaced_at
    ? daysBetween(decision.last_surfaced_at, now)
    : null;
  if (surfacedAge === null) {
    return { prunable: true, reason: `never surfaced (recorded ${recordedAge}d ago)` };
  }
  if (surfacedAge >= days) {
    return { prunable: true, reason: `last surfaced ${surfacedAge}d ago (threshold ${days}d)` };
  }
  return { prunable: false, reason: "" };
}

async function ymlFiles(root: string, rel: string): Promise<string[]> {
  const dir = path.join(root, rel);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await ymlFiles(root, path.relative(root, abs)));
    } else if (entry.isFile() && entry.name.endsWith(".yml")) {
      out.push(abs);
    }
  }
  return out;
}

async function shouldRunAuto(root: string, intervalDays: number, now: Date): Promise<boolean> {
  try {
    const raw = await readFile(path.join(root, MAINTENANCE_REL), "utf8");
    const data = JSON.parse(raw) as { last_run_at?: string };
    if (!data.last_run_at) return true;
    return daysBetween(data.last_run_at, now) >= intervalDays;
  } catch {
    return true;
  }
}

async function markAutoRun(root: string, report: PruneReport, now: Date): Promise<void> {
  const file = path.join(root, MAINTENANCE_REL);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    last_run_at: now.toISOString(),
    removed: report.removed,
    dry_run: report.dry_run,
  }, null, 2));
}

/**
 * Walk GPS memory files and remove stale low-confidence notes/decisions per
 * the pruning rules. Also removes entries past expires_at.
 *
 * Returns a summary of what was (or would be) removed.
 */
export async function pruneNotes(root: string, opts: PruneOpts = {}): Promise<PruneReport> {
  const days = opts.days ?? 90;
  const dryRun = opts.dryRun ?? false;
  const minConfidence = opts.minConfidence ?? 0.8;
  const intervalDays = opts.intervalDays ?? 7;
  const now = new Date();
  const details: PruneDetail[] = [];
  let removed = 0;

  if (opts.auto && !(await shouldRunAuto(root, intervalDays, now))) {
    return { removed: 0, dry_run: dryRun, details: [] };
  }

  for (const filePath of await ymlFiles(root, ".gps/notes")) {
    let notes: NoteT[];
    try {
      const raw = await readFile(filePath, "utf8");
      const data = parseYaml(raw);
      if (!Array.isArray(data)) continue;
      notes = data.map((d: unknown) => Note.parse(d));
    } catch {
      continue;
    }

    const kept: NoteT[] = [];
    for (const note of notes) {
      const { prunable, reason } = isPrunableNote(note, days, minConfidence, now);
      if (prunable) {
        removed++;
        details.push({
          kind: "note",
          symbol: note.symbol,
          text: note.lesson,
          reason,
          file: path.relative(root, filePath),
        });
      } else {
        kept.push(note);
      }
    }

    if (kept.length === notes.length || dryRun) continue;

    try {
      if (kept.length === 0) {
        await unlink(filePath).catch(() => {});
      } else {
        await writeFile(filePath, stringifyYaml(kept));
      }
    } catch {
      /* best-effort */
    }
  }

  for (const filePath of await ymlFiles(root, ".gps/decisions")) {
    let decisions: DecisionT[];
    try {
      const raw = await readFile(filePath, "utf8");
      const data = parseYaml(raw);
      if (!Array.isArray(data)) continue;
      decisions = data.map((d: unknown) => Decision.parse(d));
    } catch {
      continue;
    }

    const kept: DecisionT[] = [];
    for (const decision of decisions) {
      const { prunable, reason } = isPrunableDecision(decision, days, minConfidence, now);
      if (prunable) {
        removed++;
        details.push({
          kind: "decision",
          symbol: decision.symbol,
          text: decision.decision,
          reason,
          file: path.relative(root, filePath),
        });
      } else {
        kept.push(decision);
      }
    }

    if (kept.length === decisions.length || dryRun) continue;

    try {
      if (kept.length === 0) {
        await unlink(filePath).catch(() => {});
      } else {
        await writeFile(filePath, stringifyYaml(kept));
      }
    } catch {
      /* best-effort */
    }
  }

  const report = { removed, dry_run: dryRun, details };
  if (opts.auto && !dryRun) await markAutoRun(root, report, now).catch(() => {});

  return report;
}
