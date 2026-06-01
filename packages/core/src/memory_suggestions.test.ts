import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SymbolRef } from "@invariance/gps-schemas";
import { appendAssumption } from "./assumptions.js";
import { appendQuestion } from "./questions.js";
import { addTodo } from "./todos.js";
import { appendAreaNote, appendFileNote, appendNote, loadNotes } from "./notes.js";
import { writeIndex } from "./index_store.js";
import { symbolsForPrSnapshot } from "./changes.js";
import * as gh from "./gh.js";
import { applyMemorySuggestions, memorySuggestionsForSymbols, memorySuggestionsForPr } from "./memory_suggestions.js";

const roots: string[] = [];
async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-memory-suggestions-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

function symbol(name: string): SymbolRef {
  return {
    id: `${name}-id`,
    name,
    qualified_name: name,
    file: "src/refunds.ts",
    line: 1,
    kind: "function",
  };
}

describe("memorySuggestionsForSymbols", () => {
  it("recommends recording memory for touched symbols with no durable memory", async () => {
    const root = await tempRepo();

    const suggestions = await memorySuggestionsForSymbols(root, [symbol("createRefund")]);

    expect(suggestions).toEqual([
      expect.objectContaining({
        kind: "record_symbol_memory",
        symbol: "createRefund",
        priority: "medium",
        command: "gps remember 'What changed or matters about createRefund' --symbol 'createRefund'",
      }),
    ]);
  });

  it("surfaces unresolved follow-ups instead of generic memory gaps", async () => {
    const root = await tempRepo();
    await appendQuestion(root, {
      symbol: "createRefund",
      question: "Should cap failures route to manual review?",
      asked_by: "agent",
    });
    await appendAssumption(root, {
      symbol: "createRefund",
      statement: "refund inputs are pre-validated",
      confidence: "high",
      source: "agent",
    });
    await addTodo(root, {
      file: "src/refunds.ts",
      symbol: "createRefund",
      text: "Add manual review coverage",
      source: "failure",
    });

    const suggestions = await memorySuggestionsForSymbols(root, [symbol("createRefund")]);

    expect(suggestions.map((s) => s.kind).sort()).toEqual(["answer_question", "resolve_todo", "verify_assumption"]);
    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          priority: "high",
          command: "gps questions 'createRefund' --status unresolved",
          action: { tool: "questions_for", args: { symbol: "createRefund", status: "unresolved" } },
        }),
        expect.objectContaining({
          priority: "high",
          command: "gps todos 'createRefund'",
          action: { tool: "list_todos", args: { symbol: "createRefund", include_resolved: false } },
        }),
        expect.objectContaining({
          priority: "high",
          command: "gps assumptions 'createRefund' --unverified",
          action: { tool: "assumptions_for", args: { symbol: "createRefund" } },
        }),
      ]),
    );
  });

  it("does not ask for generic memory when the symbol already has durable notes", async () => {
    const root = await tempRepo();
    await appendNote(root, {
      symbol: "createRefund",
      lesson: "refund cap checks happen before issuing",
      severity: "medium",
    });

    const suggestions = await memorySuggestionsForSymbols(root, [symbol("createRefund")]);

    expect(suggestions).toEqual([]);
  });

  it("does not ask for generic memory when file-scoped memory covers the touched file", async () => {
    const root = await tempRepo();
    await appendFileNote(root, {
      id: "file-note",
      target: "src/refunds.ts",
      lesson: "refund module notes already explain the cap workflow",
      severity: "medium",
    });

    const suggestions = await memorySuggestionsForSymbols(root, [symbol("createRefund")]);

    expect(suggestions).toEqual([]);
  });

  it("does not ask for generic memory when area-scoped memory covers the touched directory", async () => {
    const root = await tempRepo();
    await appendAreaNote(root, {
      id: "area-note",
      target: "src",
      lesson: "refund code in this area follows the shared accounting path",
      severity: "medium",
    });

    const suggestions = await memorySuggestionsForSymbols(root, [symbol("createRefund")]);

    expect(suggestions).toEqual([]);
  });

  it("caps generic memory gaps per file so large changed files stay readable", async () => {
    const root = await tempRepo();

    const suggestions = await memorySuggestionsForSymbols(root, [
      symbol("first"),
      symbol("second"),
      symbol("third"),
    ]);

    expect(suggestions.map((s) => s.symbol)).toEqual(["first", "second"]);
  });

  it("attaches evidence to generated remember commands when provided", async () => {
    const root = await tempRepo();

    const suggestions = await memorySuggestionsForSymbols(root, [symbol("createRefund")], {
      evidence: "diff:origin/main",
    });

    expect(suggestions[0]?.command).toBe(
      "gps remember 'What changed or matters about createRefund' --symbol 'createRefund' --evidence 'diff:origin/main'",
    );
    expect(suggestions[0]?.remember).toEqual({
      tool: "record_learning",
      fact: "What changed or matters about createRefund",
      scope: "symbol",
      target: "createRefund",
      evidence: "diff:origin/main",
    });
    expect(suggestions[0]?.action).toEqual({
      tool: "record_lesson",
      args: {
        lesson: "What changed or matters about createRefund",
        force_scope: "symbol",
        force_target: "createRefund",
        evidence: "diff:origin/main",
      },
    });
  });

  it("applies safe record-memory suggestions as symbol notes", async () => {
    const root = await tempRepo();
    const suggestions = await memorySuggestionsForSymbols(root, [symbol("createRefund")], {
      evidence: "diff:HEAD",
    });

    const applied = await applyMemorySuggestions(root, suggestions);

    expect(applied.applied).toHaveLength(1);
    expect(applied.skipped).toEqual([]);
    const notes = await loadNotes(root, "createRefund");
    expect(notes).toEqual([
      expect.objectContaining({
        lesson: "What changed or matters about createRefund",
        evidence: "diff:HEAD",
        scope: "symbol",
        applies_to: "createRefund",
      }),
    ]);
    expect(await memorySuggestionsForSymbols(root, [symbol("createRefund")])).toEqual([]);
  });
});

describe("symbolsForPrSnapshot", () => {
  it("maps PR diff hunks to indexed symbols without touching the working tree", async () => {
    const root = await tempRepo();
    await writeIndex(root, {
      version: 2,
      built_at: new Date().toISOString(),
      root,
      files: ["src/refunds.ts"],
      symbols: [symbol("createRefund"), { ...symbol("refundReport"), line: 80, end_line: 120 }],
      edges: [],
    });

    const hits = await symbolsForPrSnapshot(root, {
      number: 17,
      title: "Update refunds",
      body: "",
      files: ["src/refunds.ts"],
      diff: [
        "diff --git a/src/refunds.ts b/src/refunds.ts",
        "--- a/src/refunds.ts",
        "+++ b/src/refunds.ts",
        "@@ -85,0 +85,2 @@",
        "+  return report;",
      ].join("\n"),
    });

    expect(hits.map((s) => s.name)).toEqual(["refundReport"]);
  });
});

describe("memorySuggestionsForPr", () => {
  it("builds a pr-sourced closeout queue from a fetched PR snapshot", async () => {
    const root = await tempRepo();
    await writeIndex(root, {
      version: 2,
      built_at: new Date().toISOString(),
      root,
      files: ["src/refunds.ts"],
      symbols: [symbol("createRefund")],
      edges: [],
    });
    vi.spyOn(gh, "fetchPr").mockResolvedValue({
      number: 21,
      title: "Refund cap",
      body: "",
      files: ["src/refunds.ts"],
      diff: [
        "--- a/src/refunds.ts",
        "+++ b/src/refunds.ts",
        "@@ -1,0 +1,1 @@",
        "+// cap",
      ].join("\n"),
    });

    const result = await memorySuggestionsForPr(root, 21);
    expect(result.source).toBe("pr");
    expect(result.pr).toEqual({ number: 21, title: "Refund cap", files: ["src/refunds.ts"] });
    expect(result.base).toBe("PR-21");
    expect(result.changed_symbols).toContain("createRefund");
    vi.restoreAllMocks();
  });
});
