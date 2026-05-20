import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getContext, impactOf, open as openQuery } from "./query.js";
import { invariantsFor, loadInvariants } from "./invariants.js";
import { changedFiles } from "./git_diff.js";
import { readIndex } from "./index_store.js";
import type { Invariant, SymbolRef } from "@invariance/gps-schemas";

const REL = ".gps/contract.json";

export interface EditContract {
  symbol: string;
  intent: string;
  created_at: string;
  allowed_files: string[];
  allowed_symbols: string[];
  invariants: Invariant[];
  required_tests: string[];
  risky_callers: string[];
  blockers: string[];
}

export interface ContractInputs {
  symbol: string;
  intent?: string;
}

export async function buildContract(root: string, input: ContractInputs): Promise<EditContract> {
  const ctx = await openQuery(root);
  const c = await getContext(
    { symbol: input.symbol, depth: 2, strands: ["structural", "tests", "provenance", "invariants"] },
    ctx,
  );
  const impact = await impactOf({ symbol: input.symbol, hops: 2 }, ctx);

  const sym = c.symbol;
  const symName = sym.qualified_name ?? sym.name;
  const all = await loadInvariants(root);
  const invs = invariantsFor(symName, all);

  const allowed_files = [...new Set([sym.file, ...impact.affected_files])].sort();
  const allowed_symbols = [
    symName,
    ...impact.affected_symbols.map((s) => s.qualified_name ?? s.name),
  ];

  const required_tests = c.tests.map((t) => t.file);
  const risky_callers = impact.affected_symbols
    .slice(0, 10)
    .map((s) => s.qualified_name ?? s.name);

  const blockers = invs
    .filter((i) => i.severity === "block")
    .map((i) => i.name);

  return {
    symbol: symName,
    intent: input.intent ?? "(unspecified)",
    created_at: new Date().toISOString(),
    allowed_files,
    allowed_symbols,
    invariants: invs,
    required_tests,
    risky_callers,
    blockers,
  };
}

export async function saveContract(root: string, contract: EditContract): Promise<void> {
  const p = path.join(root, REL);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(contract, null, 2));
}

export async function loadContract(root: string): Promise<EditContract | undefined> {
  try {
    const raw = await readFile(path.join(root, REL), "utf8");
    return JSON.parse(raw) as EditContract;
  } catch {
    return undefined;
  }
}

export interface ContractViolation {
  type: "out-of-scope-file" | "out-of-scope-symbol" | "blocker-untouched";
  detail: string;
}

export interface ContractVerifyResult {
  contract: EditContract;
  diff_files: string[];
  diff_symbols: string[];
  violations: ContractViolation[];
}

export async function verifyContract(root: string, base = "HEAD"): Promise<ContractVerifyResult | undefined> {
  const contract = await loadContract(root);
  if (!contract) return undefined;
  const diff = await changedFiles(root, base);

  let symbols: SymbolRef[] = [];
  try {
    const idx = await readIndex(root);
    const set = new Set(diff.files);
    symbols = idx.symbols.filter((s) => set.has(s.file));
  } catch {
    /* no index */
  }

  const diffSymbolIds = [...new Set(symbols.map((s) => s.qualified_name ?? s.name))];
  const allowedFiles = new Set(contract.allowed_files);
  const allowedSymbols = new Set(contract.allowed_symbols);
  const violations: ContractViolation[] = [];

  for (const f of diff.files) {
    if (!allowedFiles.has(f)) {
      violations.push({ type: "out-of-scope-file", detail: f });
    }
  }
  for (const s of diffSymbolIds) {
    if (!allowedSymbols.has(s)) {
      violations.push({ type: "out-of-scope-symbol", detail: s });
    }
  }

  return { contract, diff_files: diff.files, diff_symbols: diffSymbolIds, violations };
}
