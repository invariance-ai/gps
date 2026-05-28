import { readFile } from "node:fs/promises";
import path from "node:path";
import type { NoteScope, NoteSeverity } from "@invariance/gps-schemas";
import { open, prepareEdit, resolveSymbol } from "./query.js";
import { loadAllNotes, loadNotes, loadFileNotes, loadAreaNotes } from "./notes.js";
import { recentFailuresForSymbols, readTestRuns, type TestRun } from "./test_runs.js";
import { readObservations } from "./observer.js";
import { loadInvariants, invariantsFor } from "./invariants.js";

export type CorrectionKind =
  | "test_coverage"
  | "generated_files"
  | "existing_helper"
  | "wrong_abstraction"
  | "wrong_package"
  | "general";

const CORRECTION_PATTERNS: Array<{ kind: CorrectionKind; re: RegExp; signal: string }> = [
  { kind: "test_coverage", re: /\b(write|add|more|missing)\s+(unit\s+|integration\s+)?tests?\b/i, signal: "correction:test-coverage" },
  { kind: "generated_files", re: /\b(don'?t|do not|never|avoid)\s+touch(?:ing)?\s+generated\b|\bgenerated files?\b/i, signal: "correction:generated-files" },
  { kind: "existing_helper", re: /\b(existing|current)\s+helper\b|\buse\s+the\s+existing\b/i, signal: "correction:existing-helper" },
  { kind: "wrong_abstraction", re: /\bwrong abstraction\b|\btoo much abstraction\b|\bdon'?t abstract\b/i, signal: "correction:wrong-abstraction" },
  { kind: "wrong_package", re: /\bwrong package\b|\bbelongs in package\b|\bpackage\s+[\w@/-]+\b/i, signal: "correction:wrong-package" },
];

export function classifyCorrection(text: string): { kind: CorrectionKind; signals: string[]; severity: NoteSeverity } {
  const hits = CORRECTION_PATTERNS.filter((p) => p.re.test(text));
  if (hits.length === 0) return { kind: "general", signals: [], severity: "medium" };
  const severe = hits.some((h) => h.kind === "generated_files" || h.kind === "wrong_package");
  return {
    kind: hits[0]!.kind,
    signals: hits.map((h) => h.signal),
    severity: severe ? "high" : "medium",
  };
}

export interface LearnedTestCommand {
  symbol: string;
  command: string;
  last_passed_at: string;
  pass_count: number;
}

export async function learnedTestCommandsForSymbol(
  root: string,
  symbol: string,
  limit = 3,
): Promise<LearnedTestCommand[]> {
  const runs = await readTestRuns(root, 1000);
  const byCommand = new Map<string, LearnedTestCommand>();
  for (const r of runs) {
    if (r.exit !== 0 || !r.symbols.includes(symbol)) continue;
    const existing = byCommand.get(r.command);
    if (existing) {
      existing.pass_count++;
      if (r.at > existing.last_passed_at) existing.last_passed_at = r.at;
    } else {
      byCommand.set(r.command, {
        symbol,
        command: r.command,
        last_passed_at: r.at,
        pass_count: 1,
      });
    }
  }
  return [...byCommand.values()]
    .sort((a, b) => b.pass_count - a.pass_count || b.last_passed_at.localeCompare(a.last_passed_at))
    .slice(0, limit);
}

export interface MistakePattern {
  symbol: string;
  message: string;
  count: number;
  last_seen_at: string;
}

export async function repeatedMistakePatterns(root: string, minCount = 2): Promise<MistakePattern[]> {
  const store = await readObservations(root).catch(() => ({ version: 1 as const, symbols: {} }));
  const out: MistakePattern[] = [];
  for (const [symbol, obs] of Object.entries(store.symbols)) {
    const groups = new Map<string, { count: number; last: string }>();
    for (const f of obs.failures ?? []) {
      const key = f.message ? `${f.kind}: ${f.message.slice(0, 120)}` : `${f.kind} failure`;
      const g = groups.get(key) ?? { count: 0, last: f.at };
      g.count++;
      if (f.at > g.last) g.last = f.at;
      groups.set(key, g);
    }
    for (const [message, g] of groups) {
      if (g.count >= minCount) out.push({ symbol, message, count: g.count, last_seen_at: g.last });
    }
  }
  return out.sort((a, b) => b.count - a.count || b.last_seen_at.localeCompare(a.last_seen_at));
}

export interface HardSearchSuggestion {
  kind: "hard_search";
  symbol?: string;
  file?: string;
  command_count: number;
  why: string;
  remember_command: string;
  next_time_command?: string;
  suggestion: string;
}

interface SessionEvent {
  type?: string;
  ts?: string;
  tool?: string;
  symbol?: string;
  file?: string;
  path?: string;
}

export function detectHardSearch(events: SessionEvent[], threshold = 8): HardSearchSuggestion[] {
  const searchTools = new Set(["rg", "grep", "find", "cat", "sed", "ls", "query", "find_symbol"]);
  const recent = events.filter((e) => e.tool && searchTools.has(e.tool));
  if (recent.length < threshold) return [];
  const lastLocated = [...events].reverse().find((e) => e.file || e.path);
  const lastSymbol = [...events].reverse().find((e) => e.symbol);
  const prepared = events.some((e) => e.type === "prepare" || e.tool === "prepare_edit");
  const file = lastLocated?.file ?? lastLocated?.path;
  const symbol = lastLocated?.symbol ?? lastSymbol?.symbol;
  const target = symbol ?? file;
  const fact = symbol && file
    ? `${file} is the relevant location for ${symbol}`
    : target
    ? `${target} is the relevant location for this task`
    : "record the path, test, config, or workflow found during this search";
  const rememberCommand =
    symbol && file
      ? `gps remember ${shellQuote(fact)} --symbol ${shellQuote(symbol)}`
      : file
      ? `gps remember ${shellQuote(fact)} --file ${shellQuote(file)}`
      : `gps remember ${shellQuote(fact)}`;
  const nextTimeCommand = prepared ? undefined : `gps prepare --intent ${shellQuote("<what you are about to change>")}`;
  const why = prepared
    ? `GPS saw ${recent.length} search/read commands before this finding became clear.`
    : `GPS saw ${recent.length} search/read commands without a prior prepare brief.`;
  return [{
    kind: "hard_search",
    symbol,
    file,
    command_count: recent.length,
    why,
    remember_command: rememberCommand,
    next_time_command: nextTimeCommand,
    suggestion: symbol && file
      ? `You spent a while finding ${file} while working on ${symbol}. Save it for future agents with: ${rememberCommand}`
      : target
      ? `You spent a while finding this. Save it for future agents with: ${rememberCommand}`
      : `You spent a while searching. Save the answer for future agents with: ${rememberCommand}`,
  }];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function hardSearchSuggestionsForActiveSession(root: string): Promise<HardSearchSuggestion[]> {
  let id = "";
  try {
    id = (await readFile(path.join(root, ".gps/session/id"), "utf8")).trim();
  } catch {
    return [];
  }
  if (!id) return [];
  try {
    const raw = await readFile(path.join(root, ".gps/sessions", `${id}.jsonl`), "utf8");
    const events = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SessionEvent);
    return detectHardSearch(events);
  } catch {
    return [];
  }
}

export interface TaskPacket {
  symbol: string;
  file?: string;
  tests: LearnedTestCommand[];
  invariants: string[];
  notes: Array<{ scope: NoteScope; target?: string; lesson: string; severity: NoteSeverity; stale?: boolean }>;
  recent_failures: TestRun[];
  mistake_patterns: MistakePattern[];
  markdown: string;
}

export async function buildTaskPacket(root: string, symbol: string): Promise<TaskPacket> {
  const ctx = await open(root);
  const resolved = resolveSymbol(symbol, ctx);
  const prepared = await prepareEdit({ symbol, intent: "subagent task packet", budget: 4000 }, ctx);
  const tests = await learnedTestCommandsForSymbol(root, symbol);
  const failures = await recentFailuresForSymbols(root, [symbol], 5);
  const patterns = (await repeatedMistakePatterns(root)).filter((p) => p.symbol === symbol);
  const invariants = invariantsFor(symbol, await loadInvariants(root)).map((i) => i.rule);
  const symbolNotes = await loadNotes(root, symbol);
  const fileNotes = resolved ? await loadFileNotes(root, resolved.file) : [];
  const areaNotes = resolved ? await loadAreaNotes(root, path.dirname(resolved.file)) : [];
  const now = Date.now();
  const notes = [...symbolNotes, ...fileNotes, ...areaNotes].map((n) => {
    const ageDays = Math.floor((now - Date.parse(n.recorded_at)) / 86_400_000);
    return {
      scope: n.scope ?? "symbol",
      target: n.applies_to ?? n.symbol,
      lesson: n.lesson,
      severity: n.severity,
      stale: ageDays >= 180,
    };
  });
  return {
    symbol,
    file: resolved?.file,
    tests,
    invariants,
    notes,
    recent_failures: failures,
    mistake_patterns: patterns,
    markdown: prepared.markdown,
  };
}

export async function reviewableNotes(root: string) {
  return (await loadAllNotes(root)).filter((n) => !n.verified_by);
}
