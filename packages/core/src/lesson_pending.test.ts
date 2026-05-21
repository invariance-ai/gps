import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordLessonObservation, listPending } from "./lesson_pending.js";

const roots: string[] = [];
async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-pending-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
});

describe("recordLessonObservation fuzzy folding", () => {
  it("folds a reworded recurrence onto one counter and promotes it", async () => {
    const root = await tempRepo();
    const first = await recordLessonObservation(
      root,
      "always validate the refund amount before currency conversion",
      0.9,
    );
    expect(first.promoted).toBe(false);
    expect(first.pending.count).toBe(1);

    // Same idea, different words — should fold, not fork.
    const second = await recordLessonObservation(
      root,
      "validate refund amount prior to converting the currency",
      0.9,
    );
    expect(second.pending.count).toBe(2);
    expect(second.promoted).toBe(true);

    expect(await listPending(root)).toHaveLength(1);
  });

  it("keeps unrelated lessons on separate counters", async () => {
    const root = await tempRepo();
    await recordLessonObservation(root, "validate refund amount before currency conversion", 0.9);
    const other = await recordLessonObservation(
      root,
      "wrap stripe refund calls in withRetry, flaky on mondays",
      0.9,
    );
    expect(other.pending.count).toBe(1);
    expect(await listPending(root)).toHaveLength(2);
  });

  it("exact re-record still increments (hash path)", async () => {
    const root = await tempRepo();
    await recordLessonObservation(root, "memoize the index read", 0.8);
    const again = await recordLessonObservation(root, "memoize the index read", 0.8);
    expect(again.pending.count).toBe(2);
    expect(await listPending(root)).toHaveLength(1);
  });
});
