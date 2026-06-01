import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { readIndex } from "./index_store.js";

const execFile = promisify(_execFile);

/**
 * Map a git diff to the symbols whose line ranges overlap with changed hunks.
 *
 * Lower-level than `gate()` — pure structural mapping. Used by the live
 * watch loop and by `gps review-diff` to know *which* symbols were touched
 * (not just which files), so we can filter invariant hits to only those
 * affecting the actual changes.
 */
export interface HunkRange {
  file: string;
  start_line: number;
  end_line: number;
}

export async function changedHunks(root: string, base = "HEAD"): Promise<HunkRange[]> {
  try {
    const { stdout } = await execFile(
      "git",
      ["diff", "--unified=0", base],
      { cwd: root, maxBuffer: 8 * 1024 * 1024 },
    );
    return parseUnifiedDiff(stdout);
  } catch {
    return [];
  }
}

// Accept both standard git diff (`+++ b/path`) and `git diff --no-prefix`
// (`+++ path`) forms. The `b/` prefix is optional; `/dev/null` (deletion of
// the new-side file) is recognised and attributed to no file so deletions
// don't get mis-credited to the previously-seen header.
const FILE_HEADER = /^\+\+\+ (?:b\/)?(.+)$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(diff: string): HunkRange[] {
  const hunks: HunkRange[] = [];
  let currentFile: string | undefined;
  for (const line of diff.split("\n")) {
    const fh = FILE_HEADER.exec(line);
    if (fh) {
      const candidate = fh[1];
      // `/dev/null` on the +++ side means the file was deleted — don't
      // attribute subsequent hunks (there shouldn't be any) to it, and
      // clear any previous file so we don't mis-attribute either.
      currentFile = candidate === "/dev/null" ? undefined : candidate;
      continue;
    }
    const hh = HUNK_HEADER.exec(line);
    if (hh && currentFile) {
      const start = Number(hh[1]);
      const count = hh[2] ? Number(hh[2]) : 1;
      if (count === 0) continue; // deletion-only hunk
      hunks.push({
        file: currentFile,
        start_line: start,
        end_line: start + count - 1,
      });
    }
  }
  return hunks;
}

/**
 * Hunks for a historical commit range (`git diff <from> <to>`). Use this to map
 * a specific commit's change set to symbols — pass `from = "<sha>^"`, `to =
 * "<sha>"` for a single commit. Unlike `changedHunks` (working tree vs base),
 * both ends are explicit refs. Returns [] on any git error (bad ref, etc.).
 */
export async function changedHunksRange(
  root: string,
  from: string,
  to: string,
): Promise<HunkRange[]> {
  try {
    const { stdout } = await execFile(
      "git",
      ["diff", "--unified=0", from, to],
      { cwd: root, maxBuffer: 8 * 1024 * 1024 },
    );
    return parseUnifiedDiff(stdout);
  } catch {
    return [];
  }
}

export interface SymbolHit {
  qualified_name: string;
  file: string;
  line: number;
}

/**
 * Return symbols whose source range overlaps any of the hunks.
 *
 * Uses the symbol's `end_line` (emitted by tree-sitter; see parser_ts.ts)
 * when present so a hunk edit at line 150 inside a 200-line function (start
 * line 10) correctly maps back to the function. Falls back to treating the
 * symbol as 1-line (`end_line ?? line`) for old indexes / regex-parsed
 * symbols — that degrades to the pre-end-line behavior (decl ±1) instead of
 * regressing further.
 */
export async function symbolsInHunks(
  root: string,
  hunks: HunkRange[],
): Promise<SymbolHit[]> {
  if (hunks.length === 0) return [];
  let index;
  try {
    index = await readIndex(root);
  } catch {
    return [];
  }
  const byFile = new Map<string, HunkRange[]>();
  for (const h of hunks) {
    const arr = byFile.get(h.file) ?? [];
    arr.push(h);
    byFile.set(h.file, arr);
  }
  const out: SymbolHit[] = [];
  for (const sym of index.symbols) {
    const ranges = byFile.get(sym.file);
    if (!ranges) continue;
    // Fallback: no end_line ⇒ treat as a 1-line symbol. We expand by ±1
    // there so an edit immediately above/below a decl still matches (parity
    // with the old heuristic for indexes built before end_line tracking).
    const hasEnd = typeof sym.end_line === "number";
    const symStart = hasEnd ? sym.line : sym.line - 1;
    const symEnd = hasEnd ? (sym.end_line as number) : sym.line + 1;
    for (const r of ranges) {
      // Standard interval overlap: [symStart, symEnd] ∩ [r.start, r.end] ≠ ∅.
      if (symStart <= r.end_line && symEnd >= r.start_line) {
        out.push({
          qualified_name: sym.qualified_name ?? sym.name,
          file: sym.file,
          line: sym.line,
        });
        break;
      }
    }
  }
  return out;
}
