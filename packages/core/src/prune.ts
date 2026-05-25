import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { Note, type Note as NoteT } from "@invariance/gps-schemas";
import { isNoteExpired } from "./notes.js";
import { daysBetween } from "./time.js";

/**
 * Sources considered "trusted human" — notes from these sources are never pruned.
 */
const SAFE_SOURCES = new Set<NoteT["source"]>(["human", "doc", "incident", "pr"]);

export interface PruneDetail {
  symbol: string;
  lesson: string;
  reason: string;
}

export interface PruneReport {
  removed: number;
  dry_run: boolean;
  details: PruneDetail[];
}

export interface PruneOpts {
  days?: number;
  dryRun?: boolean;
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
function isPrunable(note: NoteT, days: number, now: Date = new Date()): { prunable: boolean; reason: string } {
  if (SAFE_SOURCES.has(note.source)) return { prunable: false, reason: "" };
  if (note.promoted) return { prunable: false, reason: "" };
  if (note.severity === "high") return { prunable: false, reason: "" };

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

/**
 * Walk the .gps/notes/ top-level directory and remove stale notes per the
 * pruning rules. Also remove notes past expires_at.
 *
 * Returns a summary of what was (or would be) removed.
 */
export async function pruneNotes(root: string, opts: PruneOpts = {}): Promise<PruneReport> {
  const days = opts.days ?? 90;
  const dryRun = opts.dryRun ?? false;
  const now = new Date();
  const details: PruneDetail[] = [];
  let removed = 0;

  const DIR = ".gps/notes";
  let files: string[];
  try {
    files = await readdir(path.join(root, DIR));
  } catch {
    return { removed: 0, dry_run: dryRun, details: [] };
  }

  for (const f of files) {
    if (!f.endsWith(".yml")) continue;
    const filePath = path.join(root, DIR, f);
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
      const { prunable, reason } = isPrunable(note, days, now);
      if (prunable) {
        removed++;
        details.push({ symbol: note.symbol, lesson: note.lesson, reason });
      } else {
        kept.push(note);
      }
    }

    if (kept.length === notes.length || dryRun) continue;

    try {
      if (kept.length === 0) {
        const { unlink } = await import("node:fs/promises");
        await unlink(filePath).catch(() => {});
      } else {
        await writeFile(filePath, stringifyYaml(kept));
      }
    } catch {
      /* best-effort */
    }
  }

  return { removed, dry_run: dryRun, details };
}

