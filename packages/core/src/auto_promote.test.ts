import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autoPromote } from "./auto_promote.js";
import { appendNote, loadNotes } from "./notes.js";
import { loadInvariants } from "./invariants.js";

const roots: string[] = [];
async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-autopromote-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
});

/** Seed `count` near-identical notes for a symbol so they cluster. */
async function seedCluster(root: string, symbol: string, lesson: string, count = 3): Promise<void> {
  for (let i = 0; i < count; i++) {
    await appendNote(root, { symbol, lesson: `${lesson} (case ${i})`, severity: "medium", source: "agent" });
  }
}

describe("autoPromote", () => {
  it("policy=never is a no-op", async () => {
    const root = await tempRepo();
    await seedCluster(root, "createWidget", "validate the widget name before saving");
    const res = await autoPromote(root, "never");
    expect(res.promoted).toHaveLength(0);
    expect(await loadInvariants(root)).toHaveLength(0);
  });

  it("policy=all promotes a benign cluster and flips notes promoted=true", async () => {
    const root = await tempRepo();
    await seedCluster(root, "createWidget", "validate the widget name before saving");
    const res = await autoPromote(root, "all");
    expect(res.promoted).toHaveLength(1);
    const invs = await loadInvariants(root);
    expect(invs).toHaveLength(1);
    expect(invs[0]!.applies_to).toContain("createWidget");
    const notes = await loadNotes(root, "createWidget");
    expect(notes.every((n) => n.promoted)).toBe(true);
  });

  it("is idempotent across runs (dedupe by name, notes already flipped)", async () => {
    const root = await tempRepo();
    await seedCluster(root, "createWidget", "validate the widget name before saving");
    await autoPromote(root, "all");
    const second = await autoPromote(root, "all");
    // notes were flipped promoted=true on the first run, so they no longer cluster
    expect(second.promoted).toHaveLength(0);
    expect(await loadInvariants(root)).toHaveLength(1);
  });

  it("policy=safe holds back a risk-topic cluster", async () => {
    const root = await tempRepo();
    await seedCluster(root, "createRefund", "always require manager approval for a refund");
    const res = await autoPromote(root, "safe");
    expect(res.promoted).toHaveLength(0);
    expect(res.skipped_risk).toHaveLength(1);
    expect(res.skipped_risk[0]!.topics).toContain("payments");
    expect(await loadInvariants(root)).toHaveLength(0);
    // notes stay un-promoted
    const notes = await loadNotes(root, "createRefund");
    expect(notes.some((n) => n.promoted)).toBe(false);
  });

  it("policy=safe promotes a benign cluster", async () => {
    const root = await tempRepo();
    await seedCluster(root, "formatName", "trim whitespace from the name field");
    const res = await autoPromote(root, "safe");
    expect(res.promoted).toHaveLength(1);
    expect(await loadInvariants(root)).toHaveLength(1);
  });

  it("dryRun returns the plan without writing", async () => {
    const root = await tempRepo();
    await seedCluster(root, "createWidget", "validate the widget name before saving");
    const res = await autoPromote(root, "all", { dryRun: true });
    expect(res.promoted).toHaveLength(1);
    expect(await loadInvariants(root)).toHaveLength(0);
    const notes = await loadNotes(root, "createWidget");
    expect(notes.some((n) => n.promoted)).toBe(false);
  });
});
