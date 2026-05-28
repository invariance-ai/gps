import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyCorrection,
  detectHardSearch,
  learnedTestCommandsForSymbol,
} from "./agent_memory.js";
import { recordTestRun } from "./test_runs.js";

const roots: string[] = [];

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-agent-memory-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("agent memory helpers", () => {
  it("classifies common user corrections", () => {
    expect(classifyCorrection("write more tests for refunds").kind).toBe("test_coverage");
    expect(classifyCorrection("don't touch generated files").kind).toBe("generated_files");
    expect(classifyCorrection("use the existing helper here").kind).toBe("existing_helper");
    expect(classifyCorrection("you picked the wrong abstraction").kind).toBe("wrong_abstraction");
    expect(classifyCorrection("this belongs in package api").kind).toBe("wrong_package");
  });

  it("learns successful targeted test commands by symbol", async () => {
    const root = await tmpRoot();
    await recordTestRun(root, {
      at: "2026-05-01T00:00:00.000Z",
      command: "pnpm test refunds.test.ts",
      exit: 0,
      symbols: ["createRefund"],
      failed_tests: [],
    });
    await recordTestRun(root, {
      at: "2026-05-02T00:00:00.000Z",
      command: "pnpm test refunds.test.ts",
      exit: 0,
      symbols: ["createRefund"],
      failed_tests: [],
    });
    await recordTestRun(root, {
      at: "2026-05-03T00:00:00.000Z",
      command: "pnpm test all",
      exit: 1,
      symbols: ["createRefund"],
      failed_tests: ["refunds fails"],
    });

    const learned = await learnedTestCommandsForSymbol(root, "createRefund");
    expect(learned).toEqual([
      {
        symbol: "createRefund",
        command: "pnpm test refunds.test.ts",
        last_passed_at: "2026-05-02T00:00:00.000Z",
        pass_count: 2,
      },
    ]);
  });

  it("detects long search sessions as memory candidates", () => {
    const events = Array.from({ length: 8 }, () => ({ type: "tool", tool: "rg" }));
    events.push({ type: "query", tool: "find", symbol: "createRefund", file: "src/refunds.ts" });
    const suggestions = detectHardSearch(events);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.suggestion).toContain("gps remember");
    expect(suggestions[0]!.remember_command).toContain("gps remember");
    expect(suggestions[0]!.next_time_command).toContain("gps prepare");
    expect(suggestions[0]!.file).toBe("src/refunds.ts");
  });

  it("anchors hard-search suggestions to the prepared symbol", () => {
    const events = [
      { type: "prepare", symbol: "createRefund" },
      ...Array.from({ length: 8 }, () => ({ type: "tool", tool: "rg", path: "src/refunds.ts" })),
    ];
    const suggestions = detectHardSearch(events);
    expect(suggestions[0]!.symbol).toBe("createRefund");
    expect(suggestions[0]!.file).toBe("src/refunds.ts");
    expect(suggestions[0]!.suggestion).toContain("--symbol 'createRefund'");
    expect(suggestions[0]!.remember_command).toBe(
      "gps remember 'src/refunds.ts is the relevant location for createRefund' --symbol 'createRefund'",
    );
    expect(suggestions[0]!.next_time_command).toBeUndefined();
  });
});
