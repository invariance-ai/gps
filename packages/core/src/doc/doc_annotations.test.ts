import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { collectAnnotations } from "./doc_annotations.js";
import { splitDiffByFile } from "./diff_split.js";
import { writeIndex, clearIndexCache, type GpsIndex } from "../index_store.js";
import { appendNote, appendFileNote } from "../notes.js";
import { appendDecision } from "../decisions.js";

const roots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-doc-ann-"));
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

const DIFF = [
  "diff --git a/src/user.ts b/src/user.ts",
  "--- a/src/user.ts",
  "+++ b/src/user.ts",
  "@@ -10,2 +10,4 @@",
  " const u = await get();",
  "+  // new",
  "+  if (!u) return get();",
  " return u;",
].join("\n");

function seedIndex(root: string): Promise<void> {
  const index: GpsIndex = {
    version: 1,
    built_at: new Date().toISOString(),
    root,
    files: ["src/user.ts"],
    symbols: [
      {
        id: "src/user.ts#fetchUser:8",
        name: "fetchUser",
        qualified_name: "fetchUser",
        file: "src/user.ts",
        line: 8,
        end_line: 20,
        kind: "function",
      },
    ],
    edges: [],
  };
  return writeIndex(root, index);
}

describe("collectAnnotations", () => {
  it("anchors a symbol note onto the symbol's range", async () => {
    const root = await tempRepo();
    await seedIndex(root);
    await appendNote(root, { symbol: "fetchUser", lesson: "Handles the null retry path." });

    const { byFile, gaps } = await collectAnnotations(root, splitDiffByFile(DIFF));
    const notes = byFile.get("src/user.ts") ?? [];
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe("Handles the null retry path.");
    expect(notes[0]!.start_line).toBe(8);
    expect(notes[0]!.end_line).toBe(20);
    // The hunk is covered by the note → no gap.
    expect(gaps).toHaveLength(0);
  });

  it("anchors a decision and pins notes by file:line evidence", async () => {
    const root = await tempRepo();
    await seedIndex(root);
    await appendDecision(root, { symbol: "fetchUser", decision: "Retry once", rationale: "transient nulls" });
    await appendNote(root, { symbol: "fetchUser", lesson: "pinned", evidence: "src/user.ts:11" });

    const { byFile } = await collectAnnotations(root, splitDiffByFile(DIFF));
    const anns = byFile.get("src/user.ts") ?? [];
    const decision = anns.find((a) => a.kind === "decision");
    expect(decision?.text).toContain("Retry once — transient nulls");
    const pinned = anns.find((a) => a.text === "pinned");
    expect(pinned?.start_line).toBe(11);
    expect(pinned?.end_line).toBe(11);
  });

  it("emits a gap for an un-annotated hunk with new code", async () => {
    const root = await tempRepo();
    await seedIndex(root); // no notes

    const { gaps } = await collectAnnotations(root, splitDiffByFile(DIFF));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.file).toBe("src/user.ts");
    expect(gaps[0]!.language).toBe("typescript");
    expect(gaps[0]!.code).toContain("if (!u) return get();");
  });

  it("anchors file-scoped notes to the file's first hunk", async () => {
    const root = await tempRepo();
    await seedIndex(root);
    await appendFileNote(root, { target: "src/user.ts", id: "fn1", lesson: "file rule" });

    const { byFile } = await collectAnnotations(root, splitDiffByFile(DIFF));
    const fileNote = (byFile.get("src/user.ts") ?? []).find((a) => a.text === "file rule");
    expect(fileNote).toBeDefined();
    expect(fileNote!.start_line).toBe(10);
  });
});
