import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addTodo, listTodos, listTodosWithNotes } from "./todos.js";
import { appendNote } from "./notes.js";

const roots: string[] = [];
async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-todos-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
});

describe("listTodosWithNotes", () => {
  it("surfaces TODO notes lifted by learn-todos (regression: gps todos showed nothing)", async () => {
    const root = await tempRepo();
    // Simulate what `learn-todos` writes: a note with source "todo".
    await appendNote(root, {
      symbol: "multiply",
      lesson: "support multiplication",
      evidence: "src/math.ts:2",
      severity: "medium",
      source: "todo",
    });

    // The old behaviour: listTodos (todos.json only) sees nothing.
    expect(await listTodos(root)).toHaveLength(0);

    // The fix: listTodosWithNotes surfaces the lifted TODO.
    const todos = await listTodosWithNotes(root);
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({
      symbol: "multiply",
      text: "support multiplication",
      file: "src/math.ts",
      line: 2,
      source: "todo",
    });
  });

  it("filters lifted TODO notes by symbol and file", async () => {
    const root = await tempRepo();
    await appendNote(root, {
      symbol: "multiply",
      lesson: "support multiplication",
      evidence: "src/math.ts:2",
      severity: "medium",
      source: "todo",
    });
    await appendNote(root, {
      symbol: "refactor",
      lesson: "clean this up",
      evidence: "src/util.py:2",
      severity: "medium",
      source: "todo",
    });

    expect(await listTodosWithNotes(root, { symbol: "multiply" })).toHaveLength(1);
    expect(await listTodosWithNotes(root, { file: "src/util.py" })).toHaveLength(1);
    expect(await listTodosWithNotes(root)).toHaveLength(2);
  });

  it("merges stored todos and lifted notes without duplicating", async () => {
    const root = await tempRepo();
    await addTodo(root, {
      file: "src/a.ts",
      symbol: "doStuff",
      text: "fix the failure",
      source: "failure",
    });
    await appendNote(root, {
      symbol: "multiply",
      lesson: "support multiplication",
      evidence: "src/math.ts:2",
      severity: "medium",
      source: "todo",
    });
    const todos = await listTodosWithNotes(root);
    expect(todos).toHaveLength(2);
    expect(todos.map((t) => t.source).sort()).toEqual(["failure", "todo"]);
  });

  it("ignores non-todo notes", async () => {
    const root = await tempRepo();
    await appendNote(root, {
      symbol: "add",
      lesson: "must stay pure",
      severity: "medium",
      source: "agent",
    });
    expect(await listTodosWithNotes(root)).toHaveLength(0);
  });
});
