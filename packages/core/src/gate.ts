import type { Invariant, SymbolRef } from "@invariance/gps-schemas";
import { loadInvariants, invariantsFor } from "./invariants.js";
import { readIndex } from "./index_store.js";
import { loadWaivers, isWaived, type Waiver } from "./waivers.js";
import { changedFiles } from "./git_diff.js";

export interface GateHit {
  invariant: Invariant;
  symbols: string[];
  files: string[];
  waived: boolean;
  waiver?: Waiver;
}

export interface GateResult {
  base: string;
  changed_files: string[];
  changed_symbols: string[];
  hits: GateHit[];
  blocking: GateHit[];
}

export interface GateOptions {
  base?: string;
  files?: string[];
}

/**
 * Incremental gate: caller supplies the touched files + symbols directly,
 * instead of asking us to re-read git. Built for the live-watch loop and
 * for PostToolUse hooks where we already know what just changed.
 */
export interface GateIncrementalInput {
  touched_files: string[];
  touched_symbols?: string[];
}

export async function gateIncremental(
  root: string,
  input: GateIncrementalInput,
): Promise<GateResult> {
  let symbols: SymbolRef[] = [];
  try {
    const idx = await readIndex(root);
    symbols = idx.symbols;
  } catch {
    // no index
  }

  const fileSet = new Set(input.touched_files);
  const explicitSymSet = input.touched_symbols ? new Set(input.touched_symbols) : undefined;
  const changed = symbols.filter((s) => {
    if (explicitSymSet) return explicitSymSet.has(s.qualified_name ?? s.name);
    return fileSet.has(s.file);
  });
  const changedSymbolIds = [...new Set(changed.map((s) => s.qualified_name ?? s.name))];

  const all = await loadInvariants(root);
  const waivers = await loadWaivers(root);
  const byInv = new Map<string, GateHit>();

  for (const sym of changed) {
    const symId = sym.qualified_name ?? sym.name;
    const applied = invariantsFor(symId, all);
    for (const inv of applied) {
      const key = inv.name;
      const waiver = waivers.find((w) => w.invariant === inv.name);
      const cur = byInv.get(key) ?? {
        invariant: inv,
        symbols: [],
        files: [],
        waived: isWaived(inv.name, waivers),
        waiver,
      };
      if (!cur.symbols.includes(symId)) cur.symbols.push(symId);
      if (!cur.files.includes(sym.file)) cur.files.push(sym.file);
      byInv.set(key, cur);
    }
  }
  for (const inv of all) {
    if (byInv.has(inv.name)) continue;
    const filesHit = input.touched_files.filter((f) =>
      inv.applies_to.some((p) => fileMatches(f, p)),
    );
    if (filesHit.length === 0) continue;
    const waiver = waivers.find((w) => w.invariant === inv.name);
    byInv.set(inv.name, {
      invariant: inv,
      symbols: [],
      files: filesHit,
      waived: isWaived(inv.name, waivers),
      waiver,
    });
  }

  const hits = [...byInv.values()].sort(
    (a, b) => severityRank(b.invariant.severity) - severityRank(a.invariant.severity),
  );
  const blocking = hits.filter((h) => h.invariant.severity === "block" && !h.waived);
  return { base: "incremental", changed_files: input.touched_files, changed_symbols: changedSymbolIds, hits, blocking };
}

export async function gate(root: string, opts: GateOptions = {}): Promise<GateResult> {
  const diff = opts.files
    ? { base: opts.base ?? "HEAD", files: opts.files }
    : await changedFiles(root, opts.base ?? "HEAD");

  let symbols: SymbolRef[] = [];
  try {
    const idx = await readIndex(root);
    symbols = idx.symbols;
  } catch {
    // no index: degrade to file-only matching
  }

  const changedSet = new Set(diff.files);
  const changed = symbols.filter((s) => changedSet.has(s.file));
  const changedSymbolIds = [...new Set(changed.map((s) => s.qualified_name ?? s.name))];

  const all = await loadInvariants(root);
  const waivers = await loadWaivers(root);
  const byInv = new Map<string, GateHit>();

  for (const sym of changed) {
    const symId = sym.qualified_name ?? sym.name;
    const applied = invariantsFor(symId, all);
    for (const inv of applied) {
      const key = inv.name;
      const waiver = waivers.find((w) => w.invariant === inv.name);
      const cur = byInv.get(key) ?? {
        invariant: inv,
        symbols: [],
        files: [],
        waived: isWaived(inv.name, waivers),
        waiver,
      };
      if (!cur.symbols.includes(symId)) cur.symbols.push(symId);
      if (!cur.files.includes(sym.file)) cur.files.push(sym.file);
      byInv.set(key, cur);
    }
  }

  for (const inv of all) {
    if (byInv.has(inv.name)) continue;
    const filesHit = diff.files.filter((f) => inv.applies_to.some((p) => fileMatches(f, p)));
    if (filesHit.length === 0) continue;
    const waiver = waivers.find((w) => w.invariant === inv.name);
    byInv.set(inv.name, {
      invariant: inv,
      symbols: [],
      files: filesHit,
      waived: isWaived(inv.name, waivers),
      waiver,
    });
  }

  const hits = [...byInv.values()].sort(
    (a, b) => severityRank(b.invariant.severity) - severityRank(a.invariant.severity),
  );
  const blocking = hits.filter((h) => h.invariant.severity === "block" && !h.waived);
  return { base: diff.base, changed_files: diff.files, changed_symbols: changedSymbolIds, hits, blocking };
}

function severityRank(s: Invariant["severity"]): number {
  if (s === "block") return 3;
  if (s === "warn") return 2;
  return 1;
}

function fileMatches(file: string, pattern: string): boolean {
  if (pattern === file) return true;
  if (pattern.endsWith("/*")) return file.startsWith(pattern.slice(0, -1));
  if (pattern.endsWith("**")) return file.startsWith(pattern.slice(0, -2));
  return false;
}
