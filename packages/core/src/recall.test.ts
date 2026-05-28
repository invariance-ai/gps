import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recallMemory, scoreText } from "./recall.js";
import { appendNote } from "./notes.js";
import { appendInvariants } from "./invariants.js";
import { appendDecision } from "./decisions.js";
import { addPreference } from "./preferences.js";

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
});
