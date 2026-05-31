import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import { Goal, type Goal as GoalT } from "@invariance/gps-schemas";

const execFile = promisify(_execFile);
const REL = ".gps/goals.json";

export function goalsPath(root: string): string {
  return path.join(root, REL);
}

function idFor(ref: string): string {
  return createHash("sha1").update(ref).digest("hex").slice(0, 12);
}

/**
 * The git ref a goal anchors to: the current branch name. Falls back to
 * "HEAD" outside a git repo or on a detached HEAD so a goal can still be saved.
 */
export async function currentRef(root: string): Promise<string> {
  try {
    const { stdout } = await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: root,
      maxBuffer: 1024 * 1024,
    });
    const ref = stdout.trim();
    return ref && ref !== "HEAD" ? ref : "HEAD";
  } catch {
    return "HEAD";
  }
}

export async function loadGoals(root: string): Promise<GoalT[]> {
  try {
    const raw = await readFile(goalsPath(root), "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.map((d: unknown) => Goal.parse(d));
  } catch {
    return [];
  }
}

async function persist(root: string, goals: GoalT[]): Promise<void> {
  const file = goalsPath(root);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(goals, null, 2));
  await rename(tmp, file);
}

/** The active goal for a ref, if any. */
export async function activeGoal(root: string, ref?: string): Promise<GoalT | undefined> {
  const r = ref ?? (await currentRef(root));
  const goals = await loadGoals(root);
  return goals.find((g) => g.ref === r && g.status === "active");
}

export interface SetGoalOpts {
  goal: string;
  detail?: string;
  ref?: string;
  source?: GoalT["source"];
}

export interface SetGoalResult {
  goal: GoalT;
  updated: boolean;
}

/**
 * Set (or replace) the active goal for a ref. Re-running on the same ref
 * updates the existing goal in place, preserving its id, todos, and
 * created_at. This is the durable counterpart to `gps prepare --intent`.
 */
export async function setGoal(root: string, opts: SetGoalOpts): Promise<SetGoalResult> {
  const ref = opts.ref ?? (await currentRef(root));
  const goals = await loadGoals(root);
  const now = new Date().toISOString();
  const existing = goals.find((g) => g.ref === ref && g.status === "active");
  if (existing) {
    existing.goal = opts.goal.trim();
    if (opts.detail !== undefined) existing.detail = opts.detail.trim() || undefined;
    if (opts.source) existing.source = opts.source;
    existing.updated_at = now;
    await persist(root, goals);
    return { goal: existing, updated: true };
  }
  const goal: GoalT = Goal.parse({
    id: idFor(ref),
    ref,
    goal: opts.goal.trim(),
    detail: opts.detail?.trim() || undefined,
    todos: [],
    status: "active",
    source: opts.source ?? "manual",
    created_at: now,
    updated_at: now,
  });
  await persist(root, [...goals, goal]);
  return { goal, updated: false };
}

/** Append a follow-up todo to the active goal for a ref. */
export async function addGoalTodo(
  root: string,
  text: string,
  ref?: string,
): Promise<GoalT | undefined> {
  const r = ref ?? (await currentRef(root));
  const goals = await loadGoals(root);
  const goal = goals.find((g) => g.ref === r && g.status === "active");
  if (!goal) return undefined;
  const t = text.trim();
  if (t && !goal.todos.includes(t)) {
    goal.todos.push(t);
    goal.updated_at = new Date().toISOString();
    await persist(root, goals);
  }
  return goal;
}

/** Mark the active goal for a ref complete. */
export async function completeGoal(root: string, ref?: string): Promise<GoalT | undefined> {
  const r = ref ?? (await currentRef(root));
  const goals = await loadGoals(root);
  const goal = goals.find((g) => g.ref === r && g.status === "active");
  if (!goal) return undefined;
  const now = new Date().toISOString();
  goal.status = "done";
  goal.completed_at = now;
  goal.updated_at = now;
  await persist(root, goals);
  return goal;
}
