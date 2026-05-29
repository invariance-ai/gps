import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { appendNote } from "./notes.js";
import { appendQuestion } from "./questions.js";
import { buildReviewQueue } from "./review.js";

const roots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-review-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

describe("buildReviewQueue", () => {
  it("returns a prioritized memory maintenance action list", async () => {
    const root = await tempRepo();
    await appendNote(root, {
      symbol: "createRefund",
      lesson: "refund cap must run before issuing money",
      severity: "high",
    });
    await appendNote(root, {
      symbol: "createRefund",
      lesson: "refund cap runs before issuing money",
      severity: "medium",
    });
    await appendNote(root, {
      symbol: "createRefund",
      lesson: "run refund cap before issuing money",
      severity: "medium",
    });
    await appendQuestion(root, {
      symbol: "createRefund",
      question: "Should failed caps route to manual review?",
      asked_by: "agent",
    });
    await mkdir(path.join(root, ".gps/notes"), { recursive: true });
    await writeFile(
      path.join(root, ".gps/notes/staleSymbol.yml"),
      stringifyYaml([
        {
          symbol: "staleSymbol",
          lesson: "old low-confidence fact",
          severity: "medium",
          promoted: false,
          recorded_at: daysAgo(120),
          source: "agent",
          confidence: 0.2,
        },
      ]),
    );

    const queue = await buildReviewQueue(root, { days: 90, limit: 10 });

    expect(queue.total).toBe(3);
    expect(queue.open_questions[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        symbol: "createRefund",
      }),
    );
    expect(queue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "promote",
          priority: "high",
          symbol: "createRefund",
          command: "gps promote 'createRefund'",
          action: { tool: "promotion_candidates", args: { symbol: "createRefund" } },
        }),
        expect.objectContaining({
          kind: "stale",
          priority: "low",
          symbol: "staleSymbol",
          age_days: expect.any(Number),
          action: { tool: "find_stale", args: { days: 90 } },
        }),
        expect.objectContaining({
          kind: "open_question",
          priority: "low",
          symbol: "createRefund",
          command: "gps questions 'createRefund' --status unresolved",
          action: { tool: "questions_for", args: { symbol: "createRefund", status: "unresolved" } },
        }),
      ]),
    );
    expect(queue.items[0]?.kind).toBe("promote");
  });
});
