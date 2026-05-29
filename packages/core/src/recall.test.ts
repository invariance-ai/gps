import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recallMemory, scoreText } from "./recall.js";
import { appendNote } from "./notes.js";
import { appendInvariants } from "./invariants.js";
import { appendDecision } from "./decisions.js";
import { addPreference } from "./preferences.js";
import { writeIndex } from "./index_store.js";
import { appendQuestion } from "./questions.js";
import { appendAssumption } from "./assumptions.js";
import { addTodo } from "./todos.js";

const roots: string[] = [];
async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-recall-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
});

describe("scoreText", () => {
  it("scores an exact phrase substring highest", () => {
    expect(scoreText("refund cap", "the refund cap is $1000")).toBe(90);
  });
  it("scores all-tokens-present above a partial match", () => {
    const all = scoreText("refund cap", "cap refunds at a threshold");
    const partial = scoreText("refund cap overflow", "cap refunds at a threshold");
    expect(all).toBeGreaterThan(partial);
    expect(partial).toBeGreaterThan(0);
  });
  it("returns 0 on no overlap and on empty query", () => {
    expect(scoreText("kubernetes", "refund handling logic")).toBe(0);
    expect(scoreText("   ", "anything")).toBe(0);
  });
});

describe("recallMemory", () => {
  it("ranks matching memory across all artifact kinds by relevance", async () => {
    const root = await tempRepo();
    await appendNote(root, {
      symbol: "createRefund",
      lesson: "always check the refund cap before issuing",
      severity: "high",
      source: "human",
    });
    await appendDecision(root, {
      symbol: "createRefund",
      decision: "refunds over $1000 require manual approval",
    });
    await appendInvariants(root, [
      { name: "refund-cap", applies_to: ["createRefund"], rule: "cap refunds at $5000", evidence: [], severity: "block" },
    ]);
    await addPreference(root, { text: "prefer named imports" }); // unrelated — should not match

    const hits = await recallMemory(root, "refund cap");
    expect(hits.length).toBeGreaterThanOrEqual(3);
    // Every returned hit is about refunds; the unrelated preference is excluded.
    expect(hits.every((h) => /refund/i.test(h.text))).toBe(true);
    expect(hits.some((h) => h.kind === "note")).toBe(true);
    expect(hits.some((h) => h.kind === "decision")).toBe(true);
    expect(hits.some((h) => h.kind === "invariant")).toBe(true);
    expect(hits.some((h) => h.kind === "preference")).toBe(false);
    // Sorted descending by score.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
  });

  it("respects the kinds filter", async () => {
    const root = await tempRepo();
    await appendNote(root, { symbol: "f", lesson: "validate the auth token", severity: "medium" });
    await appendInvariants(root, [
      { name: "auth", applies_to: ["f"], rule: "auth tokens must be verified", evidence: [], severity: "block" },
    ]);
    const onlyInvariants = await recallMemory(root, "auth", { kinds: ["invariant"] });
    expect(onlyInvariants.length).toBe(1);
    expect(onlyInvariants[0]!.kind).toBe("invariant");
  });

  it("recalls unresolved questions by topic", async () => {
    const root = await tempRepo();
    await appendQuestion(root, {
      symbol: "createRefund",
      question: "Should refund cap failures route to manual review?",
      asked_by: "agent",
    });
    const hits = await recallMemory(root, "manual review", { kinds: ["question"] });
    expect(hits).toEqual([
      expect.objectContaining({
        kind: "question",
        anchor: "createRefund",
        text: "Should refund cap failures route to manual review?",
      }),
    ]);
  });

  it("recalls unverified assumptions by topic", async () => {
    const root = await tempRepo();
    await appendAssumption(root, {
      symbol: "createRefund",
      statement: "refund inputs are pre-validated before cap checks",
      confidence: "high",
      source: "agent",
    });
    const hits = await recallMemory(root, "pre validated", { kinds: ["assumption"] });
    expect(hits).toEqual([
      expect.objectContaining({
        kind: "assumption",
        anchor: "createRefund",
        text: "refund inputs are pre-validated before cap checks",
        severity: "high",
      }),
    ]);
  });

  it("recalls unresolved todos by topic", async () => {
    const root = await tempRepo();
    await addTodo(root, {
      file: "src/refunds.ts",
      line: 12,
      symbol: "createRefund",
      text: "Add manual review coverage for refund cap failures",
      source: "manual",
    });
    const hits = await recallMemory(root, "manual review coverage", { kinds: ["todo"] });
    expect(hits).toEqual([
      expect.objectContaining({
        kind: "todo",
        anchor: "createRefund",
        text: "Add manual review coverage for refund cap failures (src/refunds.ts:12)",
      }),
    ]);
  });

  it("honors the limit", async () => {
    const root = await tempRepo();
    for (let i = 0; i < 5; i++) {
      await appendNote(root, { symbol: `s${i}`, lesson: `rate limiting rule number ${i}`, severity: "low" });
    }
    const hits = await recallMemory(root, "rate limiting", { limit: 2 });
    expect(hits.length).toBe(2);
  });

  it("returns nothing for an empty repo", async () => {
    const root = await tempRepo();
    expect(await recallMemory(root, "anything")).toEqual([]);
  });

  it("can attach related symbol graph context to memory hits", async () => {
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

    const hits = await recallMemory(root, "refund cap", { related: true });
    const related = hits.find((h) => h.kind === "note")?.related_symbols ?? [];
    expect(related).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: "createRefund", relation: "anchor" }),
        expect.objectContaining({ symbol: "handleRefund", relation: "caller" }),
        expect.objectContaining({ symbol: "checkRefundCap", relation: "callee" }),
      ]),
    );
  });

  it("keeps plain recall working when related symbols are requested without an index", async () => {
    const root = await tempRepo();
    await appendNote(root, {
      symbol: "createRefund",
      lesson: "refund cap is enforced before issuing",
      severity: "high",
    });

    const hits = await recallMemory(root, "refund cap", { related: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.related_symbols).toBeUndefined();
  });
});
