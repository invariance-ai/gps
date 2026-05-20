import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { parseUnifiedDiff, symbolsInHunks, type HunkRange } from "./diff_to_symbols.js";
import { writeIndex, clearIndexCache, type GpsIndex } from "./index_store.js";

const roots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-d2s-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
  clearIndexCache();
});

describe("parseUnifiedDiff", () => {
  it("parses single-file single-hunk diffs", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,3 +10,4 @@",
      " unchanged",
      "+added line",
      " unchanged",
      " unchanged",
    ].join("\n");
    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toEqual([{ file: "src/a.ts", start_line: 10, end_line: 13 }]);
  });

  it("handles multiple hunks across files", () => {
    const diff = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -5,1 +5,2 @@",
      " x",
      "+new",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -20 +20,3 @@",
      " y",
    ].join("\n");
    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toEqual([
      { file: "src/a.ts", start_line: 5, end_line: 6 },
      { file: "src/b.ts", start_line: 20, end_line: 22 },
    ]);
  });

  it("skips deletion-only hunks (+N,0)", () => {
    const diff = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -5,2 +5,0 @@",
      "-removed",
      "-removed",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([]);
  });

  it("accepts --no-prefix diffs (no `b/` on +++ header)", () => {
    const diff = [
      "--- src/a.ts",
      "+++ src/a.ts",
      "@@ -10,3 +10,4 @@",
      " unchanged",
      "+added line",
    ].join("\n");
    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toEqual([{ file: "src/a.ts", start_line: 10, end_line: 13 }]);
  });

  it("does not attribute hunks to /dev/null deletions", () => {
    const diff = [
      "--- a/src/a.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-removed",
      "-removed",
      "-removed",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -5,1 +5,2 @@",
      " y",
      "+new",
    ].join("\n");
    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toEqual([{ file: "src/b.ts", start_line: 5, end_line: 6 }]);
  });
});

describe("symbolsInHunks: end_line range overlap", () => {
  async function seedIndex(root: string, index: GpsIndex): Promise<void> {
    await writeIndex(root, index);
  }

  function baseIndex(root: string, symbols: GpsIndex["symbols"]): GpsIndex {
    return {
      version: 1,
      built_at: new Date().toISOString(),
      root,
      files: ["src/long.ts"],
      symbols,
      edges: [],
    };
  }

  it("matches a long function when the hunk falls mid-body (start=10, end=210, hunk@150-155)", async () => {
    const root = await tempRepo();
    await seedIndex(
      root,
      baseIndex(root, [
        {
          id: "src/long.ts#bigFn:10",
          name: "bigFn",
          qualified_name: "bigFn",
          file: "src/long.ts",
          line: 10,
          end_line: 210,
          kind: "function",
        },
      ]),
    );
    const hunks: HunkRange[] = [
      { file: "src/long.ts", start_line: 150, end_line: 155 },
    ];
    const hits = await symbolsInHunks(root, hunks);
    expect(hits.map((h) => h.qualified_name)).toEqual(["bigFn"]);
  });

  it("does NOT match a symbol starting at line 50 when the hunk is at lines 1-5", async () => {
    const root = await tempRepo();
    await seedIndex(
      root,
      baseIndex(root, [
        {
          id: "src/long.ts#laterFn:50",
          name: "laterFn",
          qualified_name: "laterFn",
          file: "src/long.ts",
          line: 50,
          end_line: 120,
          kind: "function",
        },
      ]),
    );
    const hunks: HunkRange[] = [
      { file: "src/long.ts", start_line: 1, end_line: 5 },
    ];
    const hits = await symbolsInHunks(root, hunks);
    expect(hits).toEqual([]);
  });

  it("falls back to decl ±1 when end_line is absent (no regression on old indexes)", async () => {
    const root = await tempRepo();
    await seedIndex(
      root,
      baseIndex(root, [
        {
          id: "src/long.ts#legacy:50",
          name: "legacy",
          qualified_name: "legacy",
          file: "src/long.ts",
          line: 50,
          // end_line intentionally omitted — simulates a pre-v0.6a index.
          kind: "function",
        },
      ]),
    );
    // Hunk just above decl: should still match (±1 fallback window).
    const above: HunkRange[] = [
      { file: "src/long.ts", start_line: 49, end_line: 49 },
    ];
    expect((await symbolsInHunks(root, above)).map((h) => h.qualified_name)).toEqual(["legacy"]);

    // Hunk far below decl: must NOT match (no end_line ⇒ no body coverage).
    const below: HunkRange[] = [
      { file: "src/long.ts", start_line: 120, end_line: 125 },
    ];
    expect(await symbolsInHunks(root, below)).toEqual([]);
  });
});
