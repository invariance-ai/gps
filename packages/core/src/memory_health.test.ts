import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { writeIndex } from "./index_store.js";
import { appendQuestion } from "./questions.js";
import { memoryHealth } from "./memory_health.js";

const roots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-memory-health-"));
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

describe("memoryHealth", () => {
  it("summarizes memory debt and returns invokable maintenance actions", async () => {
    const root = await tempRepo();
    await mkdir(path.join(root, ".gps/notes"), { recursive: true });
    await writeFile(
      path.join(root, ".gps/notes/oldSymbol.yml"),
      stringifyYaml([
        {
          symbol: "oldSymbol",
          lesson: "old low-confidence memory",
          severity: "medium",
          promoted: false,
          recorded_at: daysAgo(120),
          source: "agent",
          confidence: 0.2,
        },
      ]),
    );
    await appendQuestion(root, {
      symbol: "oldSymbol",
      question: "Should this behavior still exist?",
      asked_by: "agent",
    });
    await writeIndex(root, {
      version: 2,
      built_at: new Date().toISOString(),
      root,
      files: ["src/current.ts"],
      symbols: [
        { id: "current-id", name: "currentSymbol", file: "src/current.ts", line: 1, kind: "function" },
      ],
      edges: [],
    });

    const health = await memoryHealth(root, { days: 90, limit: 5, includeDiff: false });

    expect(health.status).toBe("watch");
    expect(health.score).toBeLessThan(1);
    expect(health.counts).toEqual(
      expect.objectContaining({
        symbol_notes: 1,
        review_items: 2,
        validation_issues: expect.any(Number),
        prunable: 1,
        diff_suggestions: 0,
      }),
    );
    expect(health.counts.validation_issues).toBeGreaterThan(0);
    expect(health.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "review_memory",
          action: { tool: "review_memory", args: { days: 90, limit: 5 } },
        }),
        expect.objectContaining({
          kind: "validate_knowledge",
          action: { tool: "validate_knowledge", args: {} },
        }),
        expect.objectContaining({
          kind: "prune",
          action: { tool: "prune", args: { days: 90, dry_run: true } },
        }),
      ]),
    );
    expect(health.review_items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "stale", symbol: "oldSymbol" }),
        expect.objectContaining({ kind: "open_question", symbol: "oldSymbol" }),
      ]),
    );
  });
});
