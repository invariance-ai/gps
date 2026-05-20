import { loadFeatures, topSymbols, type TopSymbol } from "./features.js";
import { loadInvariants, invariantsFor } from "./invariants.js";
import { loadAllNotes } from "./notes.js";
import { loadAllDecisions } from "./decisions.js";
import { loadAllQuestions, filterByStatus } from "./questions.js";
import { readTestRuns } from "./test_runs.js";
import type { Invariant, Note, Decision, Question } from "@invariance/gps-schemas";

export interface FeatureContext {
  feature: string;
  top_symbols: TopSymbol[];
  invariants: { invariant: Invariant; weight: number; evidence_symbol?: string }[];
  recent_decisions: Decision[];
  open_questions: Question[];
  common_tests: { file: string; runs: number; failures: number }[];
  recent_notes: Note[];
}

function matchesSymbol(symbol: string, pattern: string): boolean {
  if (pattern === symbol) return true;
  if (pattern.endsWith("*")) return symbol.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith("*")) return symbol.endsWith(pattern.slice(1));
  return symbol.endsWith("." + pattern) || symbol.endsWith("/" + pattern);
}

export async function featureContext(root: string, label: string, k = 10): Promise<FeatureContext> {
  const features = await loadFeatures(root);
  if (!features.features[label]) throw new Error(`unknown feature: ${label}`);

  const top = await topSymbols(root, label, k);
  const topIds = new Set(top.map((s) => s.id));
  const topNames = new Set(top.map((s) => normalizedName(s.id)));

  const allInv = await loadInvariants(root);
  const ranked: FeatureContext["invariants"] = [];
  for (const inv of allInv) {
    let best = 0;
    let evidence: string | undefined;
    for (const s of top) {
      const name = normalizedName(s.id);
      if (inv.applies_to.some((p) => matchesSymbol(name, p))) {
        if (s.weight > best) {
          best = s.weight;
          evidence = s.id;
        }
      }
    }
    if (best > 0) ranked.push({ invariant: inv, weight: best, evidence_symbol: evidence });
  }
  ranked.sort((a, b) => b.weight - a.weight);

  const notes = await loadAllNotes(root);
  const decisions = await loadAllDecisions(root);
  const questions = await loadAllQuestions(root);

  const recent_notes = notes
    .filter((n) => topNames.has(n.symbol) || topIds.has(n.symbol))
    .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))
    .slice(0, 5);

  const recent_decisions = decisions
    .filter((d) => topNames.has(d.symbol) || topIds.has(d.symbol))
    .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))
    .slice(0, 5);

  const open_questions = filterByStatus(questions, "unresolved")
    .filter((q) => topNames.has(q.symbol) || topIds.has(q.symbol))
    .slice(0, 5);

  const runs = await readTestRuns(root, 500);
  const counts = new Map<string, { runs: number; failures: number }>();
  for (const r of runs) {
    if (!r.symbols.some((s) => topNames.has(s))) continue;
    for (const f of r.failed_tests) {
      const file = f.split(" > ")[0] ?? f;
      const e = counts.get(file) ?? { runs: 0, failures: 0 };
      e.runs++;
      if (r.exit !== 0) e.failures++;
      counts.set(file, e);
    }
  }
  const common_tests = [...counts.entries()]
    .map(([file, c]) => ({ file, ...c }))
    .sort((a, b) => b.runs - a.runs)
    .slice(0, 5);

  return { feature: label, top_symbols: top, invariants: ranked, recent_decisions, open_questions, common_tests, recent_notes };
}

function normalizedName(id: string): string {
  // index symbol ids look like  "src/foo.ts#qualified:line"
  const hash = id.indexOf("#");
  if (hash < 0) return id;
  const tail = id.slice(hash + 1);
  const colon = tail.lastIndexOf(":");
  return colon > 0 ? tail.slice(0, colon) : tail;
}
