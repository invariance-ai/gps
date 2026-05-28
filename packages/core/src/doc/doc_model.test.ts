import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { buildPrDocModel, type LlmAnnotator } from "./doc_model.js";
import { clearIndexCache } from "../index_store.js";
import type { PrSnapshot } from "../gh.js";

const roots: string[] = [];
async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-doc-model-"));
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

const snap: PrSnapshot = {
  number: 5,
  title: "Add cache",
  body: "Adds an LRU cache.",
  diff: [
    "diff --git a/src/cache.ts b/src/cache.ts",
    "--- a/src/cache.ts",
    "+++ b/src/cache.ts",
    "@@ -1,1 +1,3 @@",
    " export const cache = new Map();",
    "+export function get(k) { return cache.get(k); }",
    "+export function set(k, v) { cache.set(k, v); }",
  ].join("\n"),
  files: ["src/cache.ts"],
};

describe("buildPrDocModel", () => {
  it("assembles a PR doc model with a file, hunks, and seeded sections", async () => {
    const root = await tempRepo(); // no index → no symbol notes, all hunks are gaps
    const model = await buildPrDocModel(root, snap, { llmFill: false });
    expect(model.kind).toBe("pr");
    expect(model.pr?.number).toBe(5);
    expect(model.files).toHaveLength(1);
    expect(model.files[0]!.path).toBe("src/cache.ts");
    expect(model.files[0]!.language).toBe("typescript");
    // PR body + "what changed" overview.
    expect(model.sections.map((s) => s.id)).toContain("description");
    expect(model.sections.map((s) => s.id)).toContain("overview");
  });

  it("merges LLM-filled annotations onto the file", async () => {
    const root = await tempRepo();
    const annotate: LlmAnnotator = async (reqs) =>
      reqs.map((r) => ({
        file: r.file,
        start_line: r.start_line,
        end_line: r.end_line,
        text: "LLM gloss",
        kind: "llm" as const,
        source: "llm",
      }));
    const model = await buildPrDocModel(root, snap, { annotate, llmFill: true });
    const anns = model.files[0]!.annotations;
    expect(anns.some((a) => a.kind === "llm" && a.text === "LLM gloss")).toBe(true);
  });

  it("truncates when the diff exceeds maxDiffBytes", async () => {
    const root = await tempRepo();
    const model = await buildPrDocModel(root, snap, { llmFill: false, maxDiffBytes: 10 });
    expect(model.files[0]!.truncated).toBe(true);
    expect(model.files[0]!.diff).toBeUndefined();
  });

  it("survives an LLM annotator that throws (notes overlay still stands)", async () => {
    const root = await tempRepo();
    const annotate: LlmAnnotator = async () => {
      throw new Error("boom");
    };
    const model = await buildPrDocModel(root, snap, { annotate, llmFill: true });
    expect(model.files).toHaveLength(1); // did not blow up
  });
});
