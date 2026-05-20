import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, mkdir, writeFile, rm, mkdtemp, cp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { wilson, formatWilsonPct, type WilsonCI } from "./stats.js";

const execFile = promisify(_execFile);

/**
 * Repo-edit-bench harness. Runs one or more coding agents (default: a
 * single `claude -p`) across two arms (without GPS, with GPS) for N
 * attempts per (agent, task, arm), runs the task's checks, and scores
 * each. Matrix mode (multiple agents) is how we surface lift on weaker
 * models when opus baseline already solves every toy task.
 *
 * Critical invariant: every attempt runs in a clean working tree. We reset
 * (or copy to a fresh tmpdir) before each attempt so arm-1's edits and
 * any `.gps/` artifacts cannot leak into arm-2.
 */
export interface BenchTask {
  id: string;
  repo: string;
  prompt: string;
  checks: string[];
}

/** A single agent the bench will run. Label is what appears in the report. */
export interface BenchAgent {
  /** Human-readable label, e.g. "opus", "haiku", or "custom". */
  label: string;
  /** Shell-style command string, parsed via parseShellArgs. */
  command: string;
}

export interface RunResult {
  task_id: string;
  arm: "baseline" | "gps";
  attempt: number;
  /** Which agent ran this attempt. Defaults to "default" when not in matrix mode. */
  agent_label: string;
  /** Whether all `checks` exited 0. */
  passed: boolean;
  failed_checks: string[];
  /** Seconds spent in the agent subprocess. */
  duration_sec: number;
  /** Stdout characters from the agent (proxy for token spend). */
  output_chars: number;
  /** True if the agent process hit the timeout. Checks are skipped in this case. */
  timed_out: boolean;
}

export interface CellSummary {
  agent_label: string;
  arm: "baseline" | "gps";
  attempts: number;
  passes: number;
  pass_rate: number;
  pass_rate_ci: WilsonCI;
  mean_duration_sec: number;
  mean_output_chars: number;
  timed_out: number;
}

export interface PerTaskAgentRow {
  agent_label: string;
  task_id: string;
  baseline_pass: number;
  gps_pass: number;
  delta: number;
}

export interface BenchSummary {
  tasks: number;
  attempts_per_arm: number;
  agents: string[];
  /** Aggregate (all agents) — kept for backwards compatibility. */
  baseline: CellSummary;
  gps: CellSummary;
  /** Per-(agent, arm) rollup. */
  cells: CellSummary[];
  /** Per-(agent, task) baseline/gps delta. */
  per_task: PerTaskAgentRow[];
  warnings: string[];
}

export async function loadTasks(dir: string): Promise<BenchTask[]> {
  const entries = await readdir(dir);
  const tasks: BenchTask[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
    const raw = await readFile(path.join(dir, entry), "utf8");
    const parsed = parseYaml(raw) as Omit<BenchTask, "id"> & { invariants_expected?: unknown };
    // `invariants_expected` was deprecated in PR #28 and is removed in P4.
    // Accept-and-ignore so legacy YAMLs in the wild don't crash the loader.
    if (parsed.invariants_expected !== undefined) delete parsed.invariants_expected;
    if (!parsed.repo || !parsed.prompt || !Array.isArray(parsed.checks)) {
      throw new Error(`bench: malformed task ${entry} (need repo, prompt, checks[])`);
    }
    tasks.push({ id: entry.replace(/\.(yml|yaml)$/, ""), ...parsed });
  }
  return tasks;
}

/** Known weaker-agent presets. Maps a short label to a canonical claude invocation.
 *  `--permission-mode bypassPermissions` is required so the headless agent can
 *  actually Edit/Write files — without it every bench task is a no-op and the
 *  pass-rate report is meaningless. */
export const AGENT_PRESETS: Record<string, string> = {
  opus: "claude -p --model claude-opus-4-7 --permission-mode bypassPermissions",
  sonnet: "claude -p --model claude-sonnet-4-6 --permission-mode bypassPermissions",
  haiku: "claude -p --model claude-haiku-4-5-20251001 --permission-mode bypassPermissions",
};

/**
 * Parse a `--matrix` value (`"opus,sonnet,haiku"`) into agents. Unknown
 * presets throw — silently substituting "claude -p --permission-mode bypassPermissions" would hide a typo
 * and produce a single-agent run that looks like a matrix run.
 */
export function parseMatrix(spec: string): BenchAgent[] {
  const labels = spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (labels.length === 0) throw new Error(`--matrix needs at least one preset; got "${spec}"`);
  return labels.map((label) => {
    const command = AGENT_PRESETS[label];
    if (!command) {
      const known = Object.keys(AGENT_PRESETS).join(", ");
      throw new Error(`unknown agent preset "${label}" (known: ${known})`);
    }
    return { label, command };
  });
}

export interface RunOptions {
  /**
   * Override the single agent command. Default: `claude -p`. Ignored if
   * `agents` is set.
   */
  agentCommand?: string;
  /** Explicit list of agents to run. Overrides `agentCommand`. */
  agents?: BenchAgent[];
  /** Repeat each (task, arm) N times to smooth variance. Default 5. */
  n?: number;
  /** Timeout per attempt in seconds. Default 300. */
  timeoutSec?: number;
}

/**
 * Minimal POSIX-ish shell-style argv parser. Handles:
 *   - whitespace splitting
 *   - single quotes (literal, no escapes inside)
 *   - double quotes (allows \" and \\ escapes)
 *   - backslash escape outside quotes
 * Throws on unterminated quotes — fail loudly rather than silently mis-tokenize.
 */
export function parseShellArgs(input: string): string[] {
  const argv: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (inSingle) {
      if (c === "'") { inSingle = false; } else { cur += c; }
      continue;
    }
    if (inDouble) {
      if (c === "\\" && i + 1 < input.length) {
        const next = input[i + 1]!;
        if (next === '"' || next === "\\" || next === "$" || next === "`") { cur += next; i++; continue; }
        cur += c; continue;
      }
      if (c === '"') { inDouble = false; } else { cur += c; }
      continue;
    }
    if (c === "'") { inSingle = true; hasToken = true; continue; }
    if (c === '"') { inDouble = true; hasToken = true; continue; }
    if (c === "\\" && i + 1 < input.length) { cur += input[i + 1]!; i++; hasToken = true; continue; }
    if (/\s/.test(c)) {
      if (hasToken) { argv.push(cur); cur = ""; hasToken = false; }
      continue;
    }
    cur += c; hasToken = true;
  }
  if (inSingle || inDouble) throw new Error(`unterminated quote in agentCommand: ${input}`);
  if (hasToken) argv.push(cur);
  return argv;
}

/**
 * Hard reset the working tree to HEAD: discard tracked-file edits, remove
 * untracked files & dirs (including `.gps/`), then also nuke `.gps/` for
 * good measure (it's gitignored in some setups).
 *
 * Throws if repoPath isn't a git repo or git returns non-zero — the bench
 * cannot produce meaningful numbers if state can't be reset between arms.
 */
export async function resetWorkingTree(repoPath: string): Promise<void> {
  try {
    await execFile("git", ["-C", repoPath, "rev-parse", "--is-inside-work-tree"]);
  } catch (err) {
    throw new Error(
      `bench reset: ${repoPath} is not a git repo (cannot guarantee a clean state between arms). ` +
      `Use copy-mode (set up tasks against a git repo) or initialize a repo there. cause=${(err as Error).message}`,
    );
  }
  await execFile("git", ["-C", repoPath, "checkout", "--", "."]);
  await execFile("git", ["-C", repoPath, "clean", "-fd"]);
  await rm(path.join(repoPath, ".gps"), { recursive: true, force: true });
  // Also scrub .mcp.json so the gps arm's MCP config cannot leak into the
  // baseline arm's next attempt (the only between-arm difference must be
  // the MCP-discovery file, written fresh each gps-arm attempt below).
  await rm(path.join(repoPath, ".mcp.json"), { recursive: true, force: true });
}

/**
 * Canonical `.mcp.json` for Claude Code (and any other MCP-discovery agent)
 * to load GPS's MCP server. We use the globally-installed `gps` binary in
 * the bench because the harness already requires `claude -p` on PATH; if
 * `gps` isn't on PATH the agent simply gets no MCP tools and the gps arm
 * degenerates to baseline (which is the honest fallback, not silent help).
 *
 * Matches the shape written by `gps install claude --use-global` in
 * packages/cli/src/commands/install.ts (`upsertClaudeMcp`).
 */
export const GPS_MCP_CONFIG = {
  mcpServers: {
    gps: { command: "gps", args: ["serve"] },
  },
} as const;

async function writeGpsMcpConfig(repoPath: string): Promise<void> {
  await writeFile(
    path.join(repoPath, ".mcp.json"),
    JSON.stringify(GPS_MCP_CONFIG, null, 2) + "\n",
  );
}

async function prepareRepoForAttempt(repoPath: string): Promise<{ workPath: string; dispose: () => Promise<void> }> {
  try { await stat(repoPath); } catch {
    throw new Error(`bench: task.repo path does not exist: ${repoPath}`);
  }
  // Treat the path as its own repo only when it's the toplevel of a git repo.
  // Otherwise (e.g. `examples/multi-symbol` inside the GPS monorepo) the
  // headless agent's cwd would be a subdir of a much larger working tree —
  // and `--permission-mode bypassPermissions` would happily let it rename
  // symbols across the parent repo. Always copy to a fresh tmpdir in that
  // case so edits stay sandboxed.
  let isOwnRepo = false;
  try {
    const { stdout } = await execFile("git", ["-C", repoPath, "rev-parse", "--show-toplevel"]);
    isOwnRepo = path.resolve(stdout.trim()) === path.resolve(repoPath);
  } catch { /* not a git repo */ }
  if (isOwnRepo) {
    await resetWorkingTree(repoPath);
    return { workPath: repoPath, dispose: async () => { /* in-place; reset on next attempt */ } };
  }
  const tmp = await mkdtemp(path.join(os.tmpdir(), "gps-bench-"));
  await cp(repoPath, tmp, { recursive: true });
  // Init a git repo in the copy so resetWorkingTree-style cleanup works for
  // subsequent attempts and so the agent sees a real repo (matters for some
  // tools that probe `git rev-parse`).
  try {
    await execFile("git", ["-C", tmp, "init", "-q"]);
    await execFile("git", ["-C", tmp, "add", "."]);
    await execFile("git", ["-C", tmp, "-c", "user.email=bench@gps.local", "-c", "user.name=bench", "commit", "-qm", "bench fixture"]);
  } catch { /* best effort */ }
  return { workPath: tmp, dispose: async () => { await rm(tmp, { recursive: true, force: true }); } };
}

export async function runTask(
  repoRoot: string,
  task: BenchTask,
  arm: "baseline" | "gps",
  attempt: number,
  opts: RunOptions = {},
  agent: BenchAgent = { label: "default", command: opts.agentCommand ?? "claude -p --permission-mode bypassPermissions" },
): Promise<RunResult> {
  const timeoutSec = opts.timeoutSec ?? 300;
  const repoPath = path.resolve(repoRoot, task.repo);

  const { workPath, dispose } = await prepareRepoForAttempt(repoPath);

  // PROMPT FAIRNESS (closes hole flagged in bench/dogfood/2026-05-16-v02-validation.md):
  // both arms get the IDENTICAL prompt. The only difference between arms is
  // whether `.mcp.json` is present in workPath — that is what an agent like
  // `claude -p` reads at session start to discover GPS's MCP tools (same
  // mechanism `gps install claude` wires up for real users). Telling the
  // baseline a tool exists via prompt-text was conflating "GPS's tools
  // helped" with "prompting the agent that tools exist helped".
  const prompt = task.prompt;
  if (arm === "gps") {
    await writeGpsMcpConfig(workPath);
  }

  const t0 = Date.now();
  let output = "";
  let timed_out = false;
  try {
    const argv = parseShellArgs(agent.command);
    const [bin, ...args] = argv;
    if (!bin) throw new Error(`empty agentCommand for agent ${agent.label}`);
    const { stdout } = await execFile(bin, [...args, prompt], {
      cwd: workPath,
      timeout: timeoutSec * 1000,
      maxBuffer: 32 * 1024 * 1024,
    });
    output = stdout;
  } catch (err) {
    const e = err as { stdout?: string; killed?: boolean; signal?: string; code?: string | number };
    output = e.stdout ?? "";
    if (e.killed === true || e.signal === "SIGTERM" || e.code === "ETIMEDOUT") {
      timed_out = true;
    }
  }
  const duration_sec = (Date.now() - t0) / 1000;

  const failed_checks: string[] = [];
  if (!timed_out) {
    for (const check of task.checks) {
      try {
        await execFile("sh", ["-c", check], { cwd: workPath, timeout: 60_000 });
      } catch {
        failed_checks.push(check);
      }
    }
  }

  try { await dispose(); } catch { /* best-effort cleanup */ }

  return {
    task_id: task.id,
    arm,
    attempt,
    agent_label: agent.label,
    passed: !timed_out && failed_checks.length === 0,
    failed_checks,
    duration_sec,
    output_chars: output.length,
    timed_out,
  };
}

function resolveAgents(opts: RunOptions): BenchAgent[] {
  if (opts.agents && opts.agents.length > 0) return opts.agents;
  return [{ label: "default", command: opts.agentCommand ?? "claude -p --permission-mode bypassPermissions" }];
}

export async function runBench(
  repoRoot: string,
  tasksDir: string,
  outDir: string,
  opts: RunOptions = {},
): Promise<BenchSummary> {
  const tasks = await loadTasks(tasksDir);
  const n = opts.n ?? 5;
  const agents = resolveAgents(opts);
  await mkdir(outDir, { recursive: true });

  const results: RunResult[] = [];
  for (const agent of agents) {
    for (const task of tasks) {
      for (let attempt = 0; attempt < n; attempt++) {
        for (const arm of ["baseline", "gps"] as const) {
          const r = await runTask(repoRoot, task, arm, attempt, opts, agent);
          results.push(r);
          // Tag per-attempt JSON by agent so matrix runs don't clobber.
          const tag = agents.length > 1 ? `${agent.label}.` : "";
          await writeFile(
            path.join(outDir, `${tag}${task.id}.${arm}.${attempt}.json`),
            JSON.stringify(r, null, 2),
          );
        }
      }
    }
  }

  const summary = summarize(results, n, agents.map((a) => a.label));
  await writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(path.join(outDir, "summary.md"), renderMarkdown(summary));
  return summary;
}

function meanOf(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}

function cell(results: RunResult[], agent_label: string, arm: "baseline" | "gps"): CellSummary {
  const passes = results.filter((r) => r.passed).length;
  return {
    agent_label,
    arm,
    attempts: results.length,
    passes,
    pass_rate: results.length === 0 ? 0 : passes / results.length,
    pass_rate_ci: wilson(passes, results.length),
    mean_duration_sec: meanOf(results.map((r) => r.duration_sec)),
    mean_output_chars: meanOf(results.map((r) => r.output_chars)),
    timed_out: results.filter((r) => r.timed_out).length,
  };
}

export function summarize(results: RunResult[], n: number, agentLabels?: string[]): BenchSummary {
  const tasks = [...new Set(results.map((r) => r.task_id))];
  const agents = agentLabels && agentLabels.length > 0
    ? agentLabels
    : [...new Set(results.map((r) => r.agent_label))];

  const cells: CellSummary[] = [];
  for (const a of agents) {
    for (const arm of ["baseline", "gps"] as const) {
      cells.push(cell(results.filter((r) => r.agent_label === a && r.arm === arm), a, arm));
    }
  }

  const per_task: PerTaskAgentRow[] = [];
  for (const a of agents) {
    for (const tid of tasks) {
      const b = results.filter((r) => r.agent_label === a && r.arm === "baseline" && r.task_id === tid);
      const d = results.filter((r) => r.agent_label === a && r.arm === "gps" && r.task_id === tid);
      const bp = b.length === 0 ? 0 : b.filter((r) => r.passed).length / b.length;
      const dp = d.length === 0 ? 0 : d.filter((r) => r.passed).length / d.length;
      per_task.push({ agent_label: a, task_id: tid, baseline_pass: bp, gps_pass: dp, delta: dp - bp });
    }
  }

  const baseline = cell(results.filter((r) => r.arm === "baseline"), "all", "baseline");
  const gps = cell(results.filter((r) => r.arm === "gps"), "all", "gps");

  const warnings: string[] = [];
  if (n < 3) {
    warnings.push(`n=${n} attempts per arm is below 3; results are not statistically meaningful (high variance).`);
  }

  return {
    tasks: tasks.length,
    attempts_per_arm: n,
    agents,
    baseline,
    gps,
    cells,
    per_task,
    warnings,
  };
}

function renderMarkdown(s: BenchSummary): string {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push(`# repo-edit-bench summary`);
  lines.push("");
  lines.push(`${s.tasks} task(s) × ${s.attempts_per_arm} attempt(s) × 2 arm(s) × ${s.agents.length} agent(s) [${s.agents.join(", ")}].`);
  lines.push("");
  for (const w of s.warnings) {
    lines.push(`> WARNING: ${w}`);
  }
  if (s.warnings.length > 0) lines.push("");

  lines.push(`## Per agent × arm`);
  lines.push("");
  lines.push(`| agent | arm | pass rate (95% CI) | mean duration (s) | mean output (chars) | timed out |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const c of s.cells) {
    lines.push(`| ${c.agent_label} | ${c.arm} | ${pct(c.pass_rate)} ${formatWilsonPct(c.pass_rate_ci)} | ${c.mean_duration_sec.toFixed(1)} | ${c.mean_output_chars.toFixed(0)} | ${c.timed_out} |`);
  }
  lines.push("");

  // Agent × task matrix only when matrix mode is in play.
  if (s.agents.length > 1 || (s.agents.length === 1 && s.agents[0] !== "default")) {
    lines.push(`## Per agent × task (baseline → gps)`);
    lines.push("");
    const tasks = [...new Set(s.per_task.map((r) => r.task_id))];
    lines.push(`| agent | ${tasks.join(" | ")} |`);
    lines.push(`|${["---", ...tasks.map(() => "---")].join("|")}|`);
    for (const a of s.agents) {
      const cells = tasks.map((tid) => {
        const row = s.per_task.find((r) => r.agent_label === a && r.task_id === tid);
        if (!row) return "—";
        const delta = (row.delta * 100).toFixed(0);
        const sign = row.delta > 0 ? "+" : "";
        return `${pct(row.baseline_pass)}→${pct(row.gps_pass)} (${sign}${delta}pp)`;
      });
      lines.push(`| ${a} | ${cells.join(" | ")} |`);
    }
    lines.push("");
  }

  lines.push(`## Per task (aggregate across agents)`);
  lines.push("");
  lines.push(`| task | baseline | gps | delta |`);
  lines.push(`|---|---|---|---|`);
  const tasks = [...new Set(s.per_task.map((r) => r.task_id))];
  for (const tid of tasks) {
    const rows = s.per_task.filter((r) => r.task_id === tid);
    const bp = meanOf(rows.map((r) => r.baseline_pass));
    const dp = meanOf(rows.map((r) => r.gps_pass));
    lines.push(`| ${tid} | ${pct(bp)} | ${pct(dp)} | ${((dp - bp) * 100).toFixed(1)}pp |`);
  }
  lines.push("");

  lines.push(`## Aggregate (all agents)`);
  lines.push("");
  lines.push(`| arm | pass rate (95% CI) | mean duration (s) | mean output (chars) | timed out |`);
  lines.push(`|---|---|---|---|---|`);
  lines.push(`| baseline | ${pct(s.baseline.pass_rate)} ${formatWilsonPct(s.baseline.pass_rate_ci)} | ${s.baseline.mean_duration_sec.toFixed(1)} | ${s.baseline.mean_output_chars.toFixed(0)} | ${s.baseline.timed_out} |`);
  lines.push(`| gps      | ${pct(s.gps.pass_rate)} ${formatWilsonPct(s.gps.pass_rate_ci)} | ${s.gps.mean_duration_sec.toFixed(1)} | ${s.gps.mean_output_chars.toFixed(0)} | ${s.gps.timed_out} |`);

  return lines.join("\n") + "\n";
}
