import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendNote } from "./notes.js";
import { appendDecision } from "./decisions.js";
import { appendInvariants } from "./invariants.js";
import { writeIndex } from "./index_store.js";
import { memoryGraph } from "./memory_graph.js";
import { appendQuestion } from "./questions.js";
import { appendAssumption } from "./assumptions.js";
import { addTodo } from "./todos.js";

const roots: string[] = [];
async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-memory-graph-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
});

describe("memoryGraph", () => {
  it("connects matching memory to anchor, caller, and callee symbols", async () => {
    const root = await tempRepo();
    await appendNote(root, {
      symbol: "createRefund",
      lesson: "refund cap is enforced before issuing",
      severity: "high",
    });
    await writeIndex(root, {
      version: 2,
      built_at: new Date().toISOString(),
      root,
      files: ["src/refunds.ts"],
      symbols: [
        { id: "caller-id", name: "handleRefund", file: "src/refunds.ts", line: 1, kind: "function" },
        { id: "refund-id", name: "createRefund", file: "src/refunds.ts", line: 5, kind: "function" },
        { id: "cap-id", name: "checkRefundCap", file: "src/refunds.ts", line: 9, kind: "function" },
      ],
      edges: [
        { from: "handleRefund", to: "createRefund", from_id: "caller-id", to_id: "refund-id", type: "calls" },
        { from: "createRefund", to: "checkRefundCap", from_id: "refund-id", to_id: "cap-id", type: "calls" },
      ],
    });

    const graph = await memoryGraph(root, "refund cap");
    expect(graph.hits).toHaveLength(1);
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "memory", kind: "note" }),
        expect.objectContaining({ type: "symbol", label: "createRefund" }),
        expect.objectContaining({ type: "symbol", label: "handleRefund" }),
        expect.objectContaining({ type: "symbol", label: "checkRefundCap" }),
      ]),
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "anchors" }),
        expect.objectContaining({ type: "calls" }),
      ]),
    );
    expect(graph.summary).toEqual(
      expect.objectContaining({
        memory_nodes: 1,
        symbol_nodes: 3,
        edges: graph.edges.length,
      }),
    );
    expect(graph.summary.central_symbols[0]).toEqual(
      expect.objectContaining({ symbol: "createRefund", memory_count: 1 }),
    );
    expect(graph.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "inspect_symbol",
          command: expect.stringContaining("gps prepare 'createRefund'"),
          action: {
            tool: "prepare_edit",
            args: { symbol: "createRefund", intent: "work on refund cap" },
          },
        }),
      ]),
    );
  });

  it("still returns memory-only graph when no symbol index exists", async () => {
    const root = await tempRepo();
    await appendNote(root, {
      symbol: "createRefund",
      lesson: "refund cap is enforced before issuing",
      severity: "high",
    });

    const graph = await memoryGraph(root, "refund cap");
    expect(graph.hits).toHaveLength(1);
    expect(graph.summary.memory_nodes).toBe(1);
    expect(graph.summary.symbol_nodes).toBe(0);
    expect(graph.nodes).toEqual([expect.objectContaining({ type: "memory", kind: "note" })]);
    expect(graph.edges).toEqual([]);
    expect(graph.recommendations.some((r) => r.kind === "record_memory")).toBe(false);
  });

  it("links memory artifacts that share an anchor or related symbol", async () => {
    const root = await tempRepo();
    await appendNote(root, {
      symbol: "createRefund",
      lesson: "refund cap is enforced before issuing",
      severity: "high",
    });
    await appendDecision(root, {
      symbol: "createRefund",
      decision: "refund cap failures return a manual-review result",
    });
    await writeIndex(root, {
      version: 2,
      built_at: new Date().toISOString(),
      root,
      files: ["src/refunds.ts"],
      symbols: [
        { id: "caller-id", name: "handleRefund", file: "src/refunds.ts", line: 1, kind: "function" },
        { id: "refund-id", name: "createRefund", file: "src/refunds.ts", line: 5, kind: "function" },
      ],
      edges: [
        { from: "handleRefund", to: "createRefund", from_id: "caller-id", to_id: "refund-id", type: "calls" },
      ],
    });

    const graph = await memoryGraph(root, "refund cap");
    expect(graph.hits.map((h) => h.kind).sort()).toEqual(["decision", "note"]);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "same_anchor" }),
        expect.objectContaining({ type: "shares_symbol" }),
      ]),
    );
  });

  it("surfaces maintenance issues for conflicting connected memory", async () => {
    const root = await tempRepo();
    await appendDecision(root, {
      symbol: "createRefund",
      decision: "refund cap is 1000 before manual review",
    });
    await appendInvariants(root, [
      {
        name: "refund-cap",
        applies_to: ["createRefund"],
        rule: "refund cap is 5000 before manual review",
        evidence: [],
        severity: "block",
      },
    ]);
    await writeIndex(root, {
      version: 2,
      built_at: new Date().toISOString(),
      root,
      files: ["src/refunds.ts"],
      symbols: [
        { id: "refund-id", name: "createRefund", file: "src/refunds.ts", line: 5, kind: "function" },
      ],
      edges: [],
    });

    const graph = await memoryGraph(root, "refund cap");
    expect(graph.summary.issues.block).toBeGreaterThanOrEqual(1);
    expect(graph.recommendations[0]).toEqual(
      expect.objectContaining({
        kind: "resolve_issue",
        priority: "high",
        command: expect.stringContaining("gps conflicts"),
        action: { tool: "find_conflicts", args: { symbol: "createRefund" } },
      }),
    );
    expect(graph.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "conflict",
          symbol: "createRefund",
          severity: "block",
        }),
      ]),
    );
  });

  it("flags recalled memory whose anchor is missing from an existing symbol graph", async () => {
    const root = await tempRepo();
    await appendNote(root, {
      symbol: "oldRefundFlow",
      lesson: "refund cap is enforced before issuing",
      severity: "medium",
    });
    await writeIndex(root, {
      version: 2,
      built_at: new Date().toISOString(),
      root,
      files: ["src/refunds.ts"],
      symbols: [
        { id: "refund-id", name: "createRefund", file: "src/refunds.ts", line: 5, kind: "function" },
      ],
      edges: [],
    });

    const graph = await memoryGraph(root, "refund cap");
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "memory", anchor: "oldRefundFlow" }),
        expect.objectContaining({ type: "symbol", label: "createRefund", kind: "match" }),
      ]),
    );
    expect(graph.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "orphan_anchor",
          symbol: "oldRefundFlow",
          severity: "warn",
        }),
      ]),
    );
  });

  it("recommends recording memory when no durable memory matches the topic", async () => {
    const root = await tempRepo();
    const graph = await memoryGraph(root, "routing fixtures");
    expect(graph.hits).toEqual([]);
    expect(graph.recommendations).toEqual([
      expect.objectContaining({
        kind: "record_memory",
        priority: "low",
        command: expect.stringContaining("gps remember"),
        action: {
          tool: "record_lesson",
          args: { lesson: "No durable memory found yet for topic: routing fixtures" },
        },
      }),
    ]);
  });

  it("seeds topic-matching symbols from the index and flags memory gaps", async () => {
    const root = await tempRepo();
    await writeIndex(root, {
      version: 2,
      built_at: new Date().toISOString(),
      root,
      files: ["src/routes.ts"],
      symbols: [
        {
          id: "load-routes-id",
          name: "loadRoutes",
          qualified_name: "loadRoutes",
          file: "src/routes.ts",
          line: 3,
          kind: "function",
          tokens: "routing fixtures route manifest",
        },
        {
          id: "normalize-id",
          name: "normalizeRoute",
          qualified_name: "normalizeRoute",
          file: "src/routes.ts",
          line: 12,
          kind: "function",
          tokens: "route normalize",
        },
      ],
      edges: [
        { from: "loadRoutes", to: "normalizeRoute", from_id: "load-routes-id", to_id: "normalize-id", type: "calls" },
      ],
    });

    const graph = await memoryGraph(root, "routing fixtures");
    expect(graph.hits).toEqual([]);
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "symbol", label: "loadRoutes", kind: "match" }),
        expect.objectContaining({ type: "symbol", label: "normalizeRoute", kind: "callee" }),
      ]),
    );
    expect(graph.edges).toEqual([expect.objectContaining({ type: "calls" })]);
    expect(graph.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "memory_gap",
          symbol: "loadRoutes",
          severity: "info",
          command: expect.stringContaining("gps remember"),
        }),
      ]),
    );
    expect(graph.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "record_memory",
          priority: "low",
          command: expect.stringContaining("--symbol 'loadRoutes'"),
          action: {
            tool: "record_lesson",
            args: {
              lesson: "What matters about routing fixtures for loadRoutes",
              force_scope: "symbol",
              force_target: "loadRoutes",
            },
          },
        }),
        expect.objectContaining({
          kind: "inspect_symbol",
          command: expect.stringContaining("gps prepare 'loadRoutes'"),
          action: {
            tool: "prepare_edit",
            args: { symbol: "loadRoutes", intent: "work on routing fixtures" },
          },
        }),
      ]),
    );
  });

  it("surfaces promotion candidates for repeated connected memory", async () => {
    const root = await tempRepo();
    for (const lesson of [
      "refund cap is enforced before issuing",
      "refund cap must be enforced before issuing",
      "enforce refund cap before issuing refunds",
    ]) {
      await appendNote(root, {
        symbol: "createRefund",
        lesson,
        severity: "medium",
      });
    }
    await writeIndex(root, {
      version: 2,
      built_at: new Date().toISOString(),
      root,
      files: ["src/refunds.ts"],
      symbols: [
        { id: "refund-id", name: "createRefund", file: "src/refunds.ts", line: 5, kind: "function" },
      ],
      edges: [],
    });

    const graph = await memoryGraph(root, "refund cap");
    expect(graph.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "promotion_candidate",
          symbol: "createRefund",
          severity: "warn",
        }),
      ]),
    );
    expect(graph.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "promote_memory",
          command: "gps promote 'createRefund'",
          action: { tool: "promotion_candidates", args: { symbol: "createRefund" } },
        }),
      ]),
    );
  });

  it("surfaces unresolved questions as graph issues and recommendations", async () => {
    const root = await tempRepo();
    await appendQuestion(root, {
      symbol: "createRefund",
      question: "Should refund cap failures route to manual review?",
      asked_by: "agent",
    });
    await writeIndex(root, {
      version: 2,
      built_at: new Date().toISOString(),
      root,
      files: ["src/refunds.ts"],
      symbols: [
        { id: "refund-id", name: "createRefund", file: "src/refunds.ts", line: 5, kind: "function" },
      ],
      edges: [],
    });

    const graph = await memoryGraph(root, "manual review");
    expect(graph.hits).toEqual([expect.objectContaining({ kind: "question", anchor: "createRefund" })]);
    expect(graph.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "open_question",
          symbol: "createRefund",
          severity: "warn",
        }),
      ]),
    );
    expect(graph.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "answer_question",
          command: "gps questions 'createRefund' --status unresolved",
          action: { tool: "questions_for", args: { symbol: "createRefund", status: "unresolved" } },
        }),
      ]),
    );
  });

  it("surfaces unverified assumptions as graph issues and recommendations", async () => {
    const root = await tempRepo();
    await appendAssumption(root, {
      symbol: "createRefund",
      statement: "refund inputs are pre-validated before cap checks",
      confidence: "high",
      source: "agent",
    });
    await writeIndex(root, {
      version: 2,
      built_at: new Date().toISOString(),
      root,
      files: ["src/refunds.ts"],
      symbols: [
        { id: "refund-id", name: "createRefund", file: "src/refunds.ts", line: 5, kind: "function" },
      ],
      edges: [],
    });

    const graph = await memoryGraph(root, "pre validated");
    expect(graph.hits).toEqual([expect.objectContaining({ kind: "assumption", anchor: "createRefund" })]);
    expect(graph.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "unverified_assumption",
          symbol: "createRefund",
          severity: "warn",
        }),
      ]),
    );
    expect(graph.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "verify_assumption",
          command: "gps assumptions 'createRefund' --unverified",
          action: { tool: "assumptions_for", args: { symbol: "createRefund" } },
        }),
      ]),
    );
  });

  it("surfaces unresolved todos as graph issues and recommendations", async () => {
    const root = await tempRepo();
    await addTodo(root, {
      file: "src/refunds.ts",
      line: 12,
      symbol: "createRefund",
      text: "Add manual review coverage for refund cap failures",
      source: "manual",
    });
    await writeIndex(root, {
      version: 2,
      built_at: new Date().toISOString(),
      root,
      files: ["src/refunds.ts"],
      symbols: [
        { id: "refund-id", name: "createRefund", file: "src/refunds.ts", line: 5, kind: "function" },
      ],
      edges: [],
    });

    const graph = await memoryGraph(root, "manual review coverage");
    expect(graph.hits).toEqual([expect.objectContaining({ kind: "todo", anchor: "createRefund" })]);
    expect(graph.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "open_todo",
          symbol: "createRefund",
          severity: "info",
        }),
      ]),
    );
    expect(graph.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "resolve_todo",
          command: "gps todos 'createRefund'",
          action: { tool: "list_todos", args: { symbol: "createRefund", include_resolved: false } },
        }),
      ]),
    );
  });
});
