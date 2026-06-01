import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  changeSummary,
  changeSummaryForPr,
  formatChangeSummaryMarkdown,
  prNumberFromMessage,
  type ChangeSummary,
} from "./changes.js";
import { writeIndex, clearIndexCache, type GpsIndex } from "./index_store.js";
import * as gh from "./gh.js";

const roots: string[] = [];
async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-changes-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
  clearIndexCache();
  vi.restoreAllMocks();
});

async function fixtureIndex(root: string): Promise<void> {
  const index: GpsIndex = {
    version: 2,
    built_at: "2024-01-01T00:00:00.000Z",
    root,
    files: ["src/refunds.ts"],
    symbols: [
      { name: "createRefund", qualified_name: "createRefund", file: "src/refunds.ts", line: 1, end_line: 40, kind: "function" },
    ],
    edges: [],
  };
  await writeIndex(root, index);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/refunds.ts"), "export function createRefund() {}\n");
}

describe("prNumberFromMessage", () => {
  it("extracts common PR references from commit messages", () => {
    expect(prNumberFromMessage("Merge pull request (#123)")).toBe(123);
    expect(prNumberFromMessage("Add refund flow PR #456")).toBe(456);
    expect(prNumberFromMessage("regular commit")).toBeUndefined();
  });
});

describe("formatChangeSummaryMarkdown", () => {
  it("renders files, symbols, commits, and PR references", () => {
    const summary: ChangeSummary = {
      base: "main",
      source: "diff",
      changed_files: ["src/refunds.ts"],
      changed_symbols: [
        {
          id: "src/refunds.ts#createRefund:10",
          name: "createRefund",
          qualified_name: "createRefund",
          file: "src/refunds.ts",
          line: 10,
          end_line: 40,
          kind: "function",
        },
      ],
      files: [
        {
          file: "src/refunds.ts",
          symbols: [
            {
              id: "src/refunds.ts#createRefund:10",
              name: "createRefund",
              qualified_name: "createRefund",
              file: "src/refunds.ts",
              line: 10,
              end_line: 40,
              kind: "function",
            },
          ],
        },
      ],
      commits: [{ sha: "abcdef123", author: "Alex", date: "2026-05-31T00:00:00Z", message: "Add cap (#7)", pr: 7 }],
      prs: [7],
    };

    const out = formatChangeSummaryMarkdown(summary);
    expect(out).toContain("# Changes vs main");
    expect(out).toContain("PR references: #7");
    expect(out).toContain("`src/refunds.ts`");
    expect(out).toContain("`createRefund`");
    expect(out).toContain("Add cap");
  });
});

describe("changeSummary — diff path", () => {
  it("returns a diff-sourced summary and never throws outside a git checkout", async () => {
    const root = await tempRepo();
    await fixtureIndex(root);
    const summary = await changeSummary(root);
    expect(summary.source).toBe("diff");
    // A bare temp dir is not a git repo, so the diff is empty — but the shape holds.
    expect(Array.isArray(summary.changed_files)).toBe(true);
    expect(Array.isArray(summary.commits)).toBe(true);
    expect(Array.isArray(summary.prs)).toBe(true);
    expect(summary.pr).toBeUndefined();
  });
});

describe("changeSummaryForPr", () => {
  it("maps a PR snapshot's diff to indexed symbols and groups them by file", async () => {
    const root = await tempRepo();
    await fixtureIndex(root);
    vi.spyOn(gh, "fetchPr").mockResolvedValue({
      number: 42,
      title: "Cap refunds",
      body: "adds a cap",
      files: ["src/refunds.ts"],
      diff: [
        "--- a/src/refunds.ts",
        "+++ b/src/refunds.ts",
        "@@ -1,1 +1,2 @@",
        " export function createRefund() {}",
        "+// cap added",
      ].join("\n"),
    });

    const summary = await changeSummaryForPr(root, 42);
    expect(summary.source).toBe("pr");
    expect(summary.pr).toEqual({ number: 42, title: "Cap refunds", body: "adds a cap" });
    expect(summary.prs).toEqual([42]);
    expect(summary.changed_files).toEqual(["src/refunds.ts"]);
    expect(summary.changed_symbols.map((s) => s.name)).toContain("createRefund");
    expect(summary.files[0]!.symbols.map((s) => s.name)).toContain("createRefund");
  });

  it("throws a clear error when gh cannot fetch the PR", async () => {
    const root = await tempRepo();
    await fixtureIndex(root);
    vi.spyOn(gh, "fetchPr").mockResolvedValue(null);
    await expect(changeSummaryForPr(root, 999)).rejects.toThrow(/failed to fetch PR #999/);
  });
});
