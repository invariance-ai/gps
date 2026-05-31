import type { Command } from "commander";
import kleur from "kleur";
import {
  setGoal,
  activeGoal,
  addGoalTodo,
  completeGoal,
  currentRef,
  loadGoals,
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface SetOpts extends RootOption {
  detail?: string;
  ref?: string;
  json?: boolean;
}

interface ShowOpts extends RootOption {
  ref?: string;
  all?: boolean;
  json?: boolean;
}

interface TodoOpts extends RootOption {
  ref?: string;
  json?: boolean;
}

interface DoneOpts extends RootOption {
  ref?: string;
  json?: boolean;
}

export function registerGoal(program: Command): void {
  const cmd = program
    .command("goal")
    .description(
      "Durable goal for the current PR/branch — what this unit of work is trying to " +
        "accomplish. Survives session resets and context compaction; surfaced by `gps resume`.",
    );

  // `gps goal "..."` is a shortcut for `gps goal set "..."`.
  addRootOption(
    cmd
      .command("set <goal>", { isDefault: true })
      .description("Set (or replace) the active goal for the current branch")
      .option("--detail <text>", "Longer context: why, constraints, acceptance criteria")
      .option("--ref <name>", "Anchor to a specific git ref instead of the current branch")
      .option("--json", "Emit JSON"),
  ).action(async (goal: string, opts: SetOpts) => {
    const root = resolveRoot(opts);
    try {
      const { goal: saved, updated } = await setGoal(root, {
        goal,
        detail: opts.detail,
        ref: opts.ref,
      });
      if (opts.json) {
        console.log(JSON.stringify({ goal: saved, updated }, null, 2));
        return;
      }
      console.log(
        `${kleur.green(updated ? "updated" : "set")} goal for ${kleur.cyan(saved.ref)}: ${saved.goal}`,
      );
      if (saved.detail) console.log(kleur.dim(`  ${saved.detail}`));
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });

  addRootOption(
    cmd
      .command("show")
      .description("Show the active goal for the current branch")
      .option("--ref <name>", "Show the goal for a specific git ref")
      .option("--all", "List every recorded goal (active and done)")
      .option("--json", "Emit JSON"),
  ).action(async (opts: ShowOpts) => {
    const root = resolveRoot(opts);
    if (opts.all) {
      const goals = await loadGoals(root);
      if (opts.json) {
        console.log(JSON.stringify({ goals }, null, 2));
        return;
      }
      if (goals.length === 0) {
        console.log(kleur.dim("no goals recorded yet"));
        return;
      }
      for (const g of goals) {
        const tag = g.status === "done" ? kleur.dim("[done]") : kleur.green("[active]");
        console.log(`${tag} ${kleur.cyan(g.ref)}: ${g.goal}`);
      }
      return;
    }

    const ref = opts.ref ?? (await currentRef(root));
    const goal = await activeGoal(root, ref);
    if (opts.json) {
      console.log(JSON.stringify({ ref, goal: goal ?? null }, null, 2));
      return;
    }
    if (!goal) {
      console.log(
        kleur.dim(`no active goal for ${ref} — set one with \`gps goal "<what you're building>"\``),
      );
      return;
    }
    console.log(kleur.bold(`Goal (${goal.ref})`));
    console.log(`  ${goal.goal}`);
    if (goal.detail) console.log(kleur.dim(`  ${goal.detail}`));
    if (goal.todos.length > 0) {
      console.log(kleur.bold("\nOpen follow-ups"));
      for (const t of goal.todos) console.log(`  - ${t}`);
    }
  });

  addRootOption(
    cmd
      .command("todo <text>")
      .description("Add a follow-up to the active goal for the current branch")
      .option("--ref <name>", "Anchor to a specific git ref")
      .option("--json", "Emit JSON"),
  ).action(async (text: string, opts: TodoOpts) => {
    const root = resolveRoot(opts);
    const goal = await addGoalTodo(root, text, opts.ref);
    if (opts.json) {
      console.log(JSON.stringify({ goal: goal ?? null }, null, 2));
      return;
    }
    if (!goal) {
      console.log(
        kleur.dim(`no active goal to attach to — set one first with \`gps goal "<...>"\``),
      );
      process.exitCode = 1;
      return;
    }
    console.log(`${kleur.green("added")} follow-up to ${kleur.cyan(goal.ref)} goal`);
  });

  addRootOption(
    cmd
      .command("done")
      .description("Mark the active goal for the current branch complete")
      .option("--ref <name>", "Anchor to a specific git ref")
      .option("--json", "Emit JSON"),
  ).action(async (opts: DoneOpts) => {
    const root = resolveRoot(opts);
    const goal = await completeGoal(root, opts.ref);
    if (opts.json) {
      console.log(JSON.stringify({ goal: goal ?? null }, null, 2));
      return;
    }
    if (!goal) {
      console.log(kleur.dim("no active goal to complete"));
      return;
    }
    console.log(`${kleur.green("done")} ${kleur.cyan(goal.ref)}: ${goal.goal}`);
  });
}
