import type { DocFileStatus } from "@invariance/gps-schemas";
import { parseUnifiedDiff, type HunkRange } from "../diff_to_symbols.js";

/**
 * One file's slice of a unified diff, with its status and new-side hunk ranges.
 *
 * `splitDiffByFile` carves a full `git diff` / `gh pr diff` blob into per-file
 * segments so the doc renderer can show each changed file independently. We
 * keep the raw segment text (`diff`) — the HTML renderer classifies each line
 * (`+`/`-`/context) from it rather than reconstructing before/after, which is
 * both simpler and exactly faithful to what git produced.
 */
export interface DiffFileSegment {
  /** New path (old path for deletions). */
  path: string;
  old_path?: string;
  status: DocFileStatus;
  binary: boolean;
  /** Raw per-file segment, starting at its `diff --git` line. */
  diff: string;
  /** New-side line ranges touched by this file's hunks. */
  hunks: HunkRange[];
}

const GIT_HEADER = /^diff --git (?:a\/)?(.+?) (?:b\/)?(.+)$/;
const OLD_FILE = /^--- (?:a\/)?(.+)$/;
const NEW_FILE = /^\+\+\+ (?:b\/)?(.+)$/;

/**
 * Split a unified diff into per-file segments. Handles standard `git diff`,
 * `--no-prefix`, additions/deletions (`/dev/null`), renames, and binary files
 * (which carry no `---`/`+++` lines). Returns `[]` for an empty/blank diff.
 */
export function splitDiffByFile(diff: string): DiffFileSegment[] {
  if (!diff.trim()) return [];
  const lines = diff.split("\n");
  const segments: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) segments.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
    // Lines before the first `diff --git` (rare preamble) are ignored.
  }
  if (current) segments.push(current);

  return segments.map((seg) => parseSegment(seg));
}

function parseSegment(seg: string[]): DiffFileSegment {
  const text = seg.join("\n");
  const headerMatch = GIT_HEADER.exec(seg[0] ?? "");
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let binary = false;
  let renamed = false;
  let added = false;
  let deleted = false;

  for (const line of seg) {
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      binary = true;
    } else if (line.startsWith("new file mode")) {
      added = true;
    } else if (line.startsWith("deleted file mode")) {
      deleted = true;
    } else if (line.startsWith("rename from") || line.startsWith("rename to")) {
      renamed = true;
    } else {
      const om = OLD_FILE.exec(line);
      if (om && om[1] !== "/dev/null") oldPath = om[1];
      const nm = NEW_FILE.exec(line);
      if (nm && nm[1] !== "/dev/null") newPath = nm[1];
      if (OLD_FILE.test(line) && om && om[1] === "/dev/null") added = true;
      if (NEW_FILE.test(line) && nm && nm[1] === "/dev/null") deleted = true;
    }
  }

  // Fall back to the `diff --git a/X b/Y` header when there are no `---`/`+++`
  // lines (binary files, mode-only changes).
  if (!oldPath && headerMatch) oldPath = headerMatch[1];
  if (!newPath && headerMatch) newPath = headerMatch[2];

  const path = deleted ? oldPath ?? newPath ?? "(unknown)" : newPath ?? oldPath ?? "(unknown)";

  let status: DocFileStatus = "modified";
  if (deleted) status = "deleted";
  else if (added) status = "added";
  else if (renamed || (oldPath && newPath && oldPath !== newPath)) status = "renamed";

  // parseUnifiedDiff keys hunks by the `+++` path; reuse it on the segment so
  // line ranges stay consistent with the rest of gps (diff_to_symbols).
  const hunks = binary ? [] : parseUnifiedDiff(text);

  return {
    path,
    old_path: oldPath && oldPath !== path ? oldPath : undefined,
    status,
    binary,
    diff: text,
    hunks,
  };
}
