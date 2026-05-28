import type { DocAnnotation, DocAnnotateRequest } from "@invariance/gps-schemas";
import type { SymbolRef } from "@invariance/gps-schemas";
import { readIndex } from "../index_store.js";
import { loadNotes, loadFileNotes } from "../notes.js";
import { loadDecisions } from "../decisions.js";
import type { HunkRange } from "../diff_to_symbols.js";
import { languageForPath } from "./highlight.js";
import type { DiffFileSegment } from "./diff_split.js";

/**
 * Overlay captured gps knowledge onto a changed diff and find the gaps.
 *
 * For every changed file we anchor existing notes/decisions onto line ranges
 * (a note's `file:line` evidence, else its symbol's `[line, end_line]`); any
 * hunk left with no annotation becomes a `DocAnnotateRequest` so the LLM can
 * fill in a plain-english gloss. Annotations whose line range can't be resolved
 * onto a changed file are returned as `unanchored` (surfaced in prose, not lost).
 */
export interface CollectedAnnotations {
  /** Anchored annotations keyed by file path. */
  byFile: Map<string, DocAnnotation[]>;
  unanchored: DocAnnotation[];
  /** Un-annotated hunks the LLM should explain. */
  gaps: DocAnnotateRequest[];
}

const EVIDENCE_LINE = /^(.+):(\d+)$/;

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && aEnd >= bStart;
}

export async function collectAnnotations(
  root: string,
  files: DiffFileSegment[],
): Promise<CollectedAnnotations> {
  const byFile = new Map<string, DocAnnotation[]>();
  const unanchored: DocAnnotation[] = [];
  const changedFiles = new Set(files.map((f) => f.path));

  const push = (a: DocAnnotation) => {
    if (!changedFiles.has(a.file)) {
      unanchored.push(a);
      return;
    }
    const arr = byFile.get(a.file) ?? [];
    arr.push(a);
    byFile.set(a.file, arr);
  };

  // 1. Resolve touched symbols (with end_line) from the index, by file+hunk
  //    overlap. Mirrors symbolsInHunks but keeps the SymbolRef so we can anchor
  //    to the symbol's full body range.
  let symbols: SymbolRef[] = [];
  try {
    symbols = (await readIndex(root)).symbols;
  } catch {
    symbols = [];
  }
  const hunksByFile = new Map<string, HunkRange[]>();
  for (const f of files) hunksByFile.set(f.path, f.hunks);

  const touched: Array<{ sym: SymbolRef; start: number; end: number }> = [];
  for (const sym of symbols) {
    const hunks = hunksByFile.get(sym.file);
    if (!hunks || hunks.length === 0) continue;
    const hasEnd = typeof sym.end_line === "number";
    const symStart = hasEnd ? sym.line : sym.line - 1;
    const symEnd = hasEnd ? (sym.end_line as number) : sym.line + 1;
    if (hunks.some((h) => overlaps(symStart, symEnd, h.start_line, h.end_line))) {
      touched.push({ sym, start: Math.max(1, symStart), end: symEnd });
    }
  }

  // 2. Anchor notes + decisions for touched symbols.
  for (const { sym, start, end } of touched) {
    const name = sym.qualified_name ?? sym.name;
    const notes = await loadNotes(root, name);
    for (const n of notes) {
      const ev = n.evidence ? EVIDENCE_LINE.exec(n.evidence) : null;
      const at = ev && ev[1] === sym.file ? Number(ev[2]) : null;
      push({
        file: sym.file,
        start_line: at ?? start,
        end_line: at ?? end,
        text: n.lesson,
        kind: n.source === "auto-lesson" ? "lesson" : "note",
        severity: n.severity,
        source: n.source,
        symbol: name,
        evidence_link: n.evidence_link ?? n.evidence,
      });
    }
    const decisions = await loadDecisions(root, name);
    for (const d of decisions) {
      const text = d.rationale ? `${d.decision} — ${d.rationale}` : d.decision;
      push({
        file: sym.file,
        start_line: start,
        end_line: end,
        text,
        kind: "decision",
        source: "decision",
        symbol: name,
        evidence_link: d.evidence_link,
      });
    }
  }

  // 3. File-scoped notes anchor to a `file:line` evidence, else to the file's
  //    first hunk so they still pin somewhere meaningful in the diff.
  for (const f of files) {
    const fileNotes = await loadFileNotes(root, f.path);
    if (fileNotes.length === 0) continue;
    const firstHunk = f.hunks[0];
    for (const n of fileNotes) {
      const ev = n.evidence ? EVIDENCE_LINE.exec(n.evidence) : null;
      const at = ev && ev[1] === f.path ? Number(ev[2]) : null;
      const start = at ?? firstHunk?.start_line ?? 1;
      const end = at ?? firstHunk?.end_line ?? start;
      push({
        file: f.path,
        start_line: start,
        end_line: end,
        text: n.lesson,
        kind: "note",
        severity: n.severity,
        source: n.source,
        evidence_link: n.evidence_link ?? n.evidence,
      });
    }
  }

  // 4. Gaps: hunks with no overlapping annotation become LLM requests.
  const gaps: DocAnnotateRequest[] = [];
  for (const f of files) {
    if (f.binary) continue;
    const anchored = byFile.get(f.path) ?? [];
    const newLines = newSideLines(f.diff);
    for (const h of f.hunks) {
      const covered = anchored.some((a) => overlaps(a.start_line, a.end_line, h.start_line, h.end_line));
      if (covered) continue;
      const code = newLines
        .filter((l) => l.kind === "add" && l.line >= h.start_line && l.line <= h.end_line)
        .map((l) => l.text)
        .join("\n");
      if (!code.trim()) continue; // deletion-only hunk; nothing new to explain
      gaps.push({
        file: f.path,
        start_line: h.start_line,
        end_line: h.end_line,
        language: languageForPath(f.path),
        code,
      });
    }
  }

  return { byFile, unanchored, gaps };
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Walk a per-file diff segment, tagging each new-side line with its number. */
export function newSideLines(
  diff: string,
): Array<{ line: number; kind: "add" | "ctx"; text: string }> {
  const out: Array<{ line: number; kind: "add" | "ctx"; text: string }> = [];
  let newLine = 0;
  for (const l of diff.split("\n")) {
    const hh = HUNK_HEADER.exec(l);
    if (hh) {
      newLine = Number(hh[1]);
      continue;
    }
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) {
      out.push({ line: newLine, kind: "add", text: l.slice(1) });
      newLine++;
    } else if (l.startsWith("-")) {
      // old-side only; does not advance the new-side counter
    } else if (l.startsWith(" ")) {
      out.push({ line: newLine, kind: "ctx", text: l.slice(1) });
      newLine++;
    }
    // `diff --git`, `index`, mode, and `\ No newline` lines are ignored.
  }
  return out;
}
