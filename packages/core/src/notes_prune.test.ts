import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { access } from "node:fs/promises";
import { appendNote, appendAreaNote, loadAreaNotes, loadNotes, pruneStaleTodoNotes, touchSurfacedNotes } from "./notes.js";

const roots: string[] = [];
async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-prune-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
});

describe("pruneStaleTodoNotes", () => {
  it("removes todo notes absent from the live set, keeps live + non-todo notes", async () => {
    const root = await tempRepo();
    await appendNote(root, { symbol: "createRefund", lesson: "stale todo", source: "todo" });
    await appendNote(root, { symbol: "createRefund", lesson: "live todo", source: "todo" });
    await appendNote(root, { symbol: "createRefund", lesson: "human lesson", source: "human" });

    const live = new Map([["createRefund", new Set(["live todo"])]]);
    const pruned = await pruneStaleTodoNotes(root, live);

    expect(pruned).toBe(1);
    const remaining = (await loadNotes(root, "createRefund")).map((n) => n.lesson).sort();
    expect(remaining).toEqual(["human lesson", "live todo"]);
  });

  it("dry-run counts without writing", async () => {
    const root = await tempRepo();
    await appendNote(root, { symbol: "foo", lesson: "gone", source: "todo" });
    const pruned = await pruneStaleTodoNotes(root, new Map(), { dryRun: true });
    expect(pruned).toBe(1);
    expect(await loadNotes(root, "foo")).toHaveLength(1); // untouched
  });

  it("deletes the file when all notes are pruned", async () => {
    const root = await tempRepo();
    await appendNote(root, { symbol: "bar", lesson: "gone", source: "todo" });
    await pruneStaleTodoNotes(root, new Map());
    expect(await loadNotes(root, "bar")).toHaveLength(0);
  });
});

describe("touchSurfacedNotes does not misroute scoped notes", () => {
  it("never writes a symbol-notes file for an area note", async () => {
    const root = await tempRepo();
    await appendAreaNote(root, { id: "a1", target: "src/api", lesson: "area directive" });
    const [areaNote] = await loadAreaNotes(root, "src/api");

    // Passing an area note must not create .gps/notes/<dir-slug>.yml.
    await touchSurfacedNotes(root, [areaNote!]);

    const slug = "src/api".replace(/[/\\:]/g, "__").replace(/\./g, "_");
    let exists = true;
    try {
      await access(path.join(root, ".gps/notes", `${slug}.yml`));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
    // The area file is intact.
    expect(await loadAreaNotes(root, "src/api")).toHaveLength(1);
  });
});
