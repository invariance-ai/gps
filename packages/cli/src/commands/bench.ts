import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import path from "node:path";
import kleur from "kleur";
import { loadTasks, runBench, parseMatrix, type BenchAgent } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

export function registerBench(program: Command): void {
  const bench = program.command("bench").description("Repo-edit-bench: A/B coding agents with and without GPS");

  addRootOption(
    bench
      .command("tasks")
      .description("List bench tasks")
      .option("--dir <path>", "Tasks directory (default bench/repo-edit-bench/tasks)"),
  ).action(async (opts: RootOption & { dir?: string }) => {
    const root = resolveRoot(opts);
    const dir = opts.dir ? path.resolve(root, opts.dir) : path.join(root, "bench/repo-edit-bench/tasks");
    const tasks = await loadTasks(dir);
    if (tasks.length === 0) {
      console.log(kleur.dim(`no tasks in ${path.relative(root, dir)}`));
      return;
    }
    for (const t of tasks) {
      console.log(`${kleur.cyan(t.id.padEnd(28))} ${kleur.dim(t.repo)}`);
      console.log(kleur.dim("  " + (t.prompt.split("\n")[0] ?? "").slice(0, 80)));
    }
  });

  addRootOption(
    bench
      .command("run")
      .description("Run bench: each task twice (baseline + gps) × n attempts × agent(s)")
      .option("--tasks <path>", "Tasks directory (default bench/repo-edit-bench/tasks)")
      .option("--out <path>", "Output directory (default bench/results/<timestamp>)")
      .option("--agent <cmd>", "Single agent command (default: `claude -p`). Overrides --matrix.")
      .option("--matrix <list>", "Comma list of presets: opus,sonnet,haiku (each runs the full bench)")
      .option("--n <n>", "Attempts per (task, arm). Default 5")
      .option("--timeout <sec>", "Per-attempt timeout in seconds. Default 300"),
  ).action(async (opts: RootOption & { tasks?: string; out?: string; agent?: string; matrix?: string; n?: string; timeout?: string }) => {
    const root = resolveRoot(opts);
    const tasksDir = opts.tasks ? path.resolve(root, opts.tasks) : path.join(root, "bench/repo-edit-bench/tasks");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = opts.out ? path.resolve(root, opts.out) : path.join(root, "bench/results", stamp);
    const n = opts.n ? Number(opts.n) : 5;
    const timeoutSec = opts.timeout ? Number(opts.timeout) : 300;

    // --agent always wins (raw command). Otherwise --matrix expands to presets.
    let agents: BenchAgent[] | undefined;
    let agentCommand: string | undefined;
    if (opts.agent) {
      agentCommand = opts.agent;
      if (opts.matrix) {
        console.log(kleur.yellow("warning: --agent overrides --matrix; running single agent only"));
      }
    } else if (opts.matrix) {
      agents = parseMatrix(opts.matrix);
    }

    const agentDesc = agents
      ? `matrix=[${agents.map((a) => a.label).join(",")}]`
      : `agent=${agentCommand ?? "claude -p"}`;
    console.log(kleur.bold("bench run") + kleur.dim(`  tasks=${path.relative(root, tasksDir)} out=${path.relative(root, outDir)} n=${n} ${agentDesc}`));

    if (n < 3) {
      console.log(kleur.yellow(`warning: n=${n} is below the n=3 minimum; results will be high-variance`));
    }

    const summary = await runBench(root, tasksDir, outDir, {
      agentCommand,
      agents,
      n,
      timeoutSec,
    });
    const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
    console.log(`\naggregate: baseline ${pct(summary.baseline.pass_rate)}  •  gps ${pct(summary.gps.pass_rate)}  •  Δ ${pct(summary.gps.pass_rate - summary.baseline.pass_rate)}`);
    if (summary.agents.length > 1) {
      for (const a of summary.agents) {
        const b = summary.cells.find((c) => c.agent_label === a && c.arm === "baseline");
        const d = summary.cells.find((c) => c.agent_label === a && c.arm === "gps");
        if (b && d) {
          console.log(`  ${kleur.cyan(a.padEnd(8))} baseline ${pct(b.pass_rate)}  gps ${pct(d.pass_rate)}  Δ ${pct(d.pass_rate - b.pass_rate)}`);
        }
      }
    }
    if (summary.baseline.timed_out > 0 || summary.gps.timed_out > 0) {
      console.log(kleur.yellow(`timed out: baseline=${summary.baseline.timed_out} gps=${summary.gps.timed_out}`));
    }
    for (const w of summary.warnings) {
      console.log(kleur.yellow(`warning: ${w}`));
    }
    console.log(kleur.dim(`summary: ${path.relative(root, path.join(outDir, "summary.md"))}`));
  });

  addRootOption(
    bench
      .command("report")
      .description("Print the markdown report from a previous `gps bench run`")
      .option("--run <path>", "Results directory (default: latest under bench/results/)"),
  ).action(async (opts: RootOption & { run?: string }) => {
    const root = resolveRoot(opts);
    let dir = opts.run ? path.resolve(root, opts.run) : undefined;
    if (!dir) {
      const { readdir } = await import("node:fs/promises");
      const root2 = path.join(root, "bench/results");
      try {
        const entries = (await readdir(root2)).sort();
        if (entries.length === 0) throw new Error("no runs");
        dir = path.join(root2, entries[entries.length - 1]!);
      } catch {
        console.error(kleur.red("no runs found under bench/results/"));
        process.exitCode = 1;
        return;
      }
    }
    const md = await readFile(path.join(dir, "summary.md"), "utf8");
    console.log(md);
  });
}
