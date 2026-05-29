import type { SymbolRef } from "@invariance/gps-schemas";
import { readIndex, type GpsIndex } from "./index_store.js";
import { changedFiles } from "./git_diff.js";
import { changedHunks, type HunkRange } from "./diff_to_symbols.js";

export interface DiffSymbols {
  base: string;
  files: string[];
  symbols: SymbolRef[];
}

/**
 * Map a working-tree diff to changed symbols.
 *
 * Prefer hunk/range overlap when git can provide tracked-file hunks and the
 * index has `end_line`; fall back to file-wide attribution for untracked files,
 * old indexes, or non-git contexts. This keeps closeout queues focused without
 * losing coverage for files git cannot produce hunks for.
 */
export async function diffSymbols(root: string, base = "HEAD"): Promise<DiffSymbols> {
  const diff = await changedFiles(root, base);
  let symbols: SymbolRef[] = [];
  try {
    const idx = await readIndex(root);
    const hunks = await changedHunks(root, base);
    symbols = symbolsForDiff(idx, diff.files, hunks);
  } catch {
    // no index
  }
  return { base: diff.base, files: diff.files, symbols };
}

export function symbolsForDiff(index: GpsIndex, files: string[], hunks: HunkRange[]): SymbolRef[] {
  const changedFiles = new Set(files);
  if (hunks.length === 0) return index.symbols.filter((s) => changedFiles.has(s.file));

  const hunkFiles = new Set(hunks.map((h) => h.file));
  const hunksByFile = new Map<string, HunkRange[]>();
  for (const hunk of hunks) {
    const arr = hunksByFile.get(hunk.file) ?? [];
    arr.push(hunk);
    hunksByFile.set(hunk.file, arr);
  }

  const out: SymbolRef[] = [];
  for (const symbol of index.symbols) {
    if (!changedFiles.has(symbol.file)) continue;
    const ranges = hunksByFile.get(symbol.file);
    if (!ranges) {
      // Usually untracked: changedFiles sees it, git diff --unified does not.
      out.push(symbol);
      continue;
    }
    if (ranges.some((range) => overlapsSymbol(symbol, range))) out.push(symbol);
  }

  // If every changed file had hunks but none overlapped, preserve the more
  // precise empty result instead of inflating back to file-wide symbols.
  if (out.length === 0 && [...changedFiles].some((file) => !hunkFiles.has(file))) {
    return index.symbols.filter((s) => changedFiles.has(s.file) && !hunkFiles.has(s.file));
  }
  return out;
}

function overlapsSymbol(symbol: SymbolRef, range: HunkRange): boolean {
  const hasEnd = typeof symbol.end_line === "number";
  const start = hasEnd ? symbol.line : symbol.line - 1;
  const end = hasEnd ? symbol.end_line! : symbol.line + 1;
  return start <= range.end_line && end >= range.start_line;
}
