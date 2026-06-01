import type { SymbolRef } from "@invariance/gps-schemas";
import path from "node:path";
import { symbolsForPrSnapshot } from "./changes.js";
import { diffSymbols } from "./diff_symbols.js";
import { fetchPr } from "./gh.js";
import { filterExpiredNotes, loadAreaNotes, loadFileNotes, loadNotes } from "./notes.js";
import { filterExpiredDecisions, loadDecisions } from "./decisions.js";
import { filterByStatus, loadQuestions } from "./questions.js";
import { loadAssumptions } from "./assumptions.js";
import { invariantsFor, loadInvariants } from "./invariants.js";
import { listTodos } from "./todos.js";
import { persistLesson, type PersistLessonResult } from "./lessons.js";

export type MemorySuggestionKind =
  | "record_symbol_memory"
  | "answer_question"
  | "verify_assumption"
  | "resolve_todo";

export interface MemorySuggestion {
  kind: MemorySuggestionKind;
  symbol: string;
  file: string;
  priority: "high" | "medium" | "low";
  reason: string;
  command: string;
  action?: MemorySuggestionAction;
  remember?: MemorySuggestionRememberAction;
}

export type MemorySuggestionAction =
  | {
      tool: "record_lesson";
      args: {
        lesson: string;
        force_scope: "symbol";
        force_target: string;
        evidence?: string;
      };
    }
  | {
      tool: "questions_for";
      args: {
        symbol: string;
        status: "unresolved";
      };
    }
  | {
      tool: "assumptions_for";
      args: {
        symbol: string;
      };
    }
  | {
      tool: "list_todos";
      args: {
        symbol: string;
        include_resolved: false;
      };
    };

export interface MemorySuggestionRememberAction {
  tool: "record_learning";
  fact: string;
  scope: "symbol";
  target: string;
  evidence?: string;
}

export interface MemorySuggestionOptions {
  base?: string;
  pr?: number | string;
  limit?: number;
  evidence?: string;
}

export interface MemorySuggestionResult {
  base: string;
  source: "diff" | "pr";
  pr?: {
    number: number;
    title: string;
    files: string[];
  };
  changed_files: string[];
  changed_symbol_count: number;
  changed_symbols: string[];
  suggestions: MemorySuggestion[];
}

export interface AppliedMemorySuggestion {
  suggestion: MemorySuggestion;
  result: PersistLessonResult;
}

export interface ApplyMemorySuggestionsResult {
  applied: AppliedMemorySuggestion[];
  skipped: MemorySuggestion[];
}

export async function memorySuggestionsForDiff(
  root: string,
  opts: MemorySuggestionOptions = {},
): Promise<MemorySuggestionResult> {
  if (opts.pr !== undefined) return memorySuggestionsForPr(root, opts.pr, opts);
  const diff = await diffSymbols(root, opts.base ?? "HEAD");
  const evidence = opts.evidence ?? `diff:${diff.base}`;
  const suggestions = await memorySuggestionsForSymbols(root, diff.symbols, {
    limit: opts.limit,
    evidence,
  });
  return {
    base: diff.base,
    source: "diff",
    changed_files: diff.files,
    changed_symbol_count: diff.symbols.length,
    changed_symbols: diff.symbols.map(symbolName).slice(0, 50),
    suggestions,
  };
}

export async function memorySuggestionsForPr(
  root: string,
  pr: number | string,
  opts: Pick<MemorySuggestionOptions, "limit" | "evidence"> = {},
): Promise<MemorySuggestionResult> {
  const snapshot = await fetchPr(pr);
  if (!snapshot) throw new Error(`failed to fetch PR #${pr} via gh`);
  const symbols = await symbolsForPrSnapshot(root, snapshot);
  const evidence = opts.evidence ?? `pr:#${snapshot.number}`;
  const suggestions = await memorySuggestionsForSymbols(root, symbols, {
    limit: opts.limit,
    evidence,
  });
  return {
    base: `PR-${snapshot.number}`,
    source: "pr",
    pr: {
      number: snapshot.number,
      title: snapshot.title,
      files: snapshot.files,
    },
    changed_files: snapshot.files,
    changed_symbol_count: symbols.length,
    changed_symbols: symbols.map(symbolName).slice(0, 50),
    suggestions,
  };
}

export async function memorySuggestionsForSymbols(
  root: string,
  symbols: SymbolRef[],
  opts: number | Pick<MemorySuggestionOptions, "limit" | "evidence"> = {},
): Promise<MemorySuggestion[]> {
  const limit = typeof opts === "number" ? opts : opts.limit ?? 20;
  const evidence = typeof opts === "number" ? undefined : opts.evidence;
  const invariants = await loadInvariants(root);
  const out: MemorySuggestion[] = [];
  const seen = new Set<string>();
  const order = new Map<string, number>();
  const genericGapsByFile = new Map<string, number>();
  symbols.forEach((symbol, index) => {
    if (!order.has(symbolName(symbol))) order.set(symbolName(symbol), index);
  });

  const add = (suggestion: MemorySuggestion) => {
    const key = `${suggestion.kind}|${suggestion.symbol}|${suggestion.command}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(suggestion);
  };

  for (const symbol of symbols) {
    const name = symbolName(symbol);
    const area = path.dirname(symbol.file);
    const [symbolNotes, fileNotes, areaNotes, decisions, questions, assumptions, todos] = await Promise.all([
      loadNotes(root, name).then((items) => filterExpiredNotes(items)),
      loadFileNotes(root, symbol.file).then((items) => filterExpiredNotes(items)),
      area && area !== "." ? loadAreaNotes(root, area).then((items) => filterExpiredNotes(items)) : Promise.resolve([]),
      loadDecisions(root, name).then((items) => filterExpiredDecisions(items)),
      loadQuestions(root, name),
      loadAssumptions(root, name),
      listTodos(root, { symbol: name }),
    ]);
    const openQuestions = filterByStatus(questions, "unresolved");
    const unverifiedAssumptions = assumptions.filter((a) => !a.verified);
    const relatedInvariants = invariantsFor(name, invariants);

    for (const q of openQuestions.slice(0, 2)) {
      add({
        kind: "answer_question",
        symbol: name,
        file: symbol.file,
        priority: "high",
        reason: `open question still affects this touched symbol: ${q.question}`,
        command: `gps questions ${shellQuote(name)} --status unresolved`,
        action: {
          tool: "questions_for",
          args: { symbol: name, status: "unresolved" },
        },
      });
    }

    for (const a of unverifiedAssumptions.slice(0, 2)) {
      add({
        kind: "verify_assumption",
        symbol: name,
        file: symbol.file,
        priority: a.confidence === "high" ? "high" : "medium",
        reason: `unverified ${a.confidence}-confidence assumption still affects this touched symbol: ${a.statement}`,
        command: `gps assumptions ${shellQuote(name)} --unverified`,
        action: {
          tool: "assumptions_for",
          args: { symbol: name },
        },
      });
    }

    for (const t of todos.slice(0, 2)) {
      add({
        kind: "resolve_todo",
        symbol: name,
        file: symbol.file,
        priority: t.source === "failure" ? "high" : "medium",
        reason: `unresolved TODO still affects this touched symbol: ${t.text}`,
        command: `gps todos ${shellQuote(name)}`,
        action: {
          tool: "list_todos",
          args: { symbol: name, include_resolved: false },
        },
      });
    }

    const durableCount =
      symbolNotes.length +
      fileNotes.length +
      areaNotes.length +
      decisions.length +
      openQuestions.length +
      unverifiedAssumptions.length +
      todos.length +
      relatedInvariants.length;
    if (durableCount === 0) {
      const gapsForFile = genericGapsByFile.get(symbol.file) ?? 0;
      if (gapsForFile >= 2) continue;
      genericGapsByFile.set(symbol.file, gapsForFile + 1);
      const fact = `What changed or matters about ${name}`;
      add({
        kind: "record_symbol_memory",
        symbol: name,
        file: symbol.file,
        priority: "medium",
        reason: "this touched symbol has no durable GPS memory yet",
        command: rememberCommand(fact, name, evidence),
        action: {
          tool: "record_lesson",
          args: {
            lesson: fact,
            force_scope: "symbol",
            force_target: name,
            ...(evidence ? { evidence } : {}),
          },
        },
        remember: {
          tool: "record_learning",
          fact,
          scope: "symbol",
          target: name,
          ...(evidence ? { evidence } : {}),
        },
      });
    }
  }

  return out
    .sort(
      (a, b) =>
        priorityRank(b.priority) - priorityRank(a.priority) ||
        (order.get(a.symbol) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.symbol) ?? Number.MAX_SAFE_INTEGER) ||
        a.symbol.localeCompare(b.symbol),
    )
    .slice(0, limit);
}

export async function applyMemorySuggestions(
  root: string,
  suggestions: MemorySuggestion[],
): Promise<ApplyMemorySuggestionsResult> {
  const applied: AppliedMemorySuggestion[] = [];
  const skipped: MemorySuggestion[] = [];
  for (const suggestion of suggestions) {
    if (!suggestion.remember) {
      skipped.push(suggestion);
      continue;
    }
    const result = await persistLesson(root, {
      scope: suggestion.remember.scope,
      target: suggestion.remember.target,
      lesson: suggestion.remember.fact,
      evidence: suggestion.remember.evidence,
      severity: "medium",
      classifier: {
        signals: ["memory-suggestions", "forced"],
        confidence: 1,
        used_llm: false,
      },
    });
    applied.push({ suggestion, result });
  }
  return { applied, skipped };
}

function symbolName(symbol: SymbolRef): string {
  return symbol.qualified_name ?? symbol.name;
}

function priorityRank(priority: MemorySuggestion["priority"]): number {
  return priority === "high" ? 3 : priority === "medium" ? 2 : 1;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function rememberCommand(fact: string, symbol: string, evidence?: string): string {
  const parts = [
    "gps remember",
    shellQuote(fact),
    "--symbol",
    shellQuote(symbol),
  ];
  if (evidence) parts.push("--evidence", shellQuote(evidence));
  return parts.join(" ");
}
