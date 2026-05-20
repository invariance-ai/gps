import type { SymbolRef } from "@invariance/gps-schemas";
import { readIndex } from "./index_store.js";
import { changedFiles } from "./git_diff.js";

export interface DiffSymbols {
  base: string;
  files: string[];
  symbols: SymbolRef[];
}

/** Map a working-tree diff to the symbols that live in those files. */
export async function diffSymbols(root: string, base = "HEAD"): Promise<DiffSymbols> {
  const diff = await changedFiles(root, base);
  const set = new Set(diff.files);
  let symbols: SymbolRef[] = [];
  try {
    const idx = await readIndex(root);
    symbols = idx.symbols.filter((s) => set.has(s.file));
  } catch {
    // no index
  }
  return { base: diff.base, files: diff.files, symbols };
}
