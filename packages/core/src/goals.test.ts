import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setGoal, loadGoals, activeGoal, addGoalTodo, completeGoal } from "./goals.js";

const roots: string[] = [];
async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-goals-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
});

describe("goals", () => {
  it("persists and reloads a goal for a ref", async () => {
    const root = await tempRepo();
    const { goal, updated } = await setGoal(root, {
      goal: "Add a $5000 refund cap",
      detail: "non-enterprise only",
      ref: "feature/cap",
    });
    expect(updated).toBe(false);
    expect(goal.goal).toBe("Add a $5000 refund cap");
    expect(goal.status).toBe("active");

    const loaded = await loadGoals(root);
    expect(loaded).toHaveLength(1);
    expect(await activeGoal(root, "feature/cap")).toMatchObject({ goal: "Add a $5000 refund cap" });
  });

  it("updates the active goal in place on the same ref (stable id, preserved todos)", async () => {
    const root = await tempRepo();
    const first = await setGoal(root, { goal: "draft", ref: "feature/x" });
    await addGoalTodo(root, "write tests", "feature/x");
    const second = await setGoal(root, { goal: "final goal", ref: "feature/x" });

    expect(second.updated).toBe(true);
    expect(second.goal.id).toBe(first.goal.id);
    expect(second.goal.goal).toBe("final goal");
    expect(second.goal.todos).toEqual(["write tests"]);
    expect(await loadGoals(root)).toHaveLength(1);
  });

  it("keeps separate active goals per ref", async () => {
    const root = await tempRepo();
    await setGoal(root, { goal: "goal A", ref: "branch-a" });
    await setGoal(root, { goal: "goal B", ref: "branch-b" });
    expect(await activeGoal(root, "branch-a")).toMatchObject({ goal: "goal A" });
    expect(await activeGoal(root, "branch-b")).toMatchObject({ goal: "goal B" });
  });

  it("appends follow-up todos without duplicating", async () => {
    const root = await tempRepo();
    await setGoal(root, { goal: "g", ref: "r" });
    await addGoalTodo(root, "update fixture", "r");
    await addGoalTodo(root, "update fixture", "r");
    const goal = await addGoalTodo(root, "add migration", "r");
    expect(goal?.todos).toEqual(["update fixture", "add migration"]);
  });

  it("completing a goal frees the ref for a new active goal", async () => {
    const root = await tempRepo();
    await setGoal(root, { goal: "old", ref: "r" });
    const done = await completeGoal(root, "r");
    expect(done?.status).toBe("done");
    expect(await activeGoal(root, "r")).toBeUndefined();

    const { updated } = await setGoal(root, { goal: "new", ref: "r" });
    expect(updated).toBe(false);
    expect(await loadGoals(root)).toHaveLength(2);
  });
});
