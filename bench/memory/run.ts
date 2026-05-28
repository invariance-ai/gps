/**
 * Cross-session memory benchmark runner.
 *
 *   S1 TEACH   developer-sim issues the rule in a natural paraphrase → gps capture fires
 *   ── approve gate (gps: approve; unapproved: leave in inbox = negative control)
 *   S2..Sk TEST  FRESH sessions given a related task WITHOUT restating the rule
 *
 * The only variable across arms is persistence/injection. `planTrial` is a pure function
 * (unit-tested, and printed by `--plan-only`); the live path reuses the core harness's
 * agent-invocation idiom + GPS_MCP_CONFIG and is run by the operator (needs `claude` + key).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseShellArgs, GPS_MCP_CONFIG } from "@invariance/gps-core";
import {
  type Arm,
  type Rule,
  type PlannedStep,
  type RunOptions,
  type SessionResult,
  type TrialResult,
  ALL_ARMS,
  DEFAULT_RUN_OPTIONS,
} from "./types.js";
import { pickParaphrase, teachPrompt, testPrompt } from "./developer-sim.js";
import { gradeSession, defaultJudge, isClaudeAvailable, surfaceMarkers, type JudgeFn } from "./grader.js";
import { resetCodeOnly, wipeMemory, resetAll } from "./reset.js";

const exec = promisify(execFile);

/** Deterministic seed in [0,1) for paraphrase choice, so trials are reproducible. */
function trialSeed(rule: Rule, arm: Arm, trial: number): number {
  let h = 2166136261 >>> 0;
  for (const ch of `${rule.id}:${arm}:${trial}`) {
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  }
  return (h % 100000) / 100000;
}

/**
 * Pure plan of one (rule, arm, trial). The arm determines mcp presence, memory wiping,
 * rule injection, and whether the captured rule is approved out of the inbox.
 */
export function planTrial(rule: Rule, arm: Arm, opts: RunOptions): PlannedStep[] {
  const steps: PlannedStep[] = [];
  const hasGps = arm === "gps" || arm === "unapproved";
  const paraphrase = pickParaphrase(rule, trialSeed(rule, arm, opts.trials));

  // in-context is the "told every time" ceiling: no learning phase at all.
  if (arm !== "in-context") {
    steps.push({
      phase: "teach",
      arm,
      rule_id: rule.id,
      trial: opts.trials,
      session_index: 0,
      prompt: teachPrompt(rule, paraphrase),
      mcpEnabled: hasGps,
      memoryWiped: false,
      ruleInjected: false,
      approveInbox: false,
    });
  }

  // Approve gate exists only where gps captured something.
  if (hasGps) {
    steps.push({
      phase: "approve",
      arm,
      rule_id: rule.id,
      trial: opts.trials,
      session_index: 0,
      mcpEnabled: hasGps,
      memoryWiped: false,
      ruleInjected: false,
      approveInbox: arm === "gps",
      note: arm === "unapproved" ? "left in inbox — negative control (must not leak)" : undefined,
    });
  }

  for (let s = 1; s <= opts.testSessions; s++) {
    steps.push({
      phase: "test",
      arm,
      rule_id: rule.id,
      trial: opts.trials,
      session_index: s,
      prompt: testPrompt(rule, arm === "in-context"),
      mcpEnabled: hasGps,
      memoryWiped: arm === "baseline",
      ruleInjected: arm === "in-context",
      approveInbox: false,
    });
  }
  return steps;
}

/** Load and lightly validate a rule-bank directory of YAML files. */
export async function loadRules(dir: string): Promise<Rule[]> {
  const entries = await readdir(dir);
  const rules: Rule[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
    const raw = await readFile(path.join(dir, entry), "utf8");
    const parsed = parseYaml(raw) as Partial<Rule>;
    validateRule(parsed, entry);
    rules.push(parsed as Rule);
  }
  return rules;
}

export function validateRule(r: Partial<Rule>, source: string): asserts r is Rule {
  const types = ["preference", "directive", "decision", "lesson"];
  if (!r.id) throw new Error(`${source}: missing id`);
  if (!r.type || !types.includes(r.type)) throw new Error(`${r.id}: type must be one of ${types.join("|")}`);
  if (!r.canonical) throw new Error(`${r.id}: missing canonical`);
  if (!Array.isArray(r.paraphrases) || r.paraphrases.length === 0) throw new Error(`${r.id}: needs ≥1 paraphrase`);
  if (r.paraphrases.some((p) => p.toLowerCase() === r.canonical!.toLowerCase())) {
    throw new Error(`${r.id}: a paraphrase equals the canonical (would leak the exact string)`);
  }
  if (!r.test_task) throw new Error(`${r.id}: missing test_task`);
  if (!r.adherence_check || (r.adherence_check.kind !== "grep" && r.adherence_check.kind !== "judge")) {
    throw new Error(`${r.id}: adherence_check.kind must be grep|judge`);
  }
  if (!r.adherence_check.expect) throw new Error(`${r.id}: adherence_check.expect required`);
  if (!r.tension) throw new Error(`${r.id}: missing tension (honored must be observable)`);
  if (r.type === "decision" && !r.rejected) throw new Error(`${r.id}: decision rules need a rejected alternative`);
}

// ───────────────────────── token accounting (E6) ─────────────────────────

export interface AgentUsage {
  out: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  numTurns: number;
}

/**
 * Parse `claude -p --output-format json`. Token counts are summed across `modelUsage` (every
 * model + sub-agent the session used) so the total is CUMULATIVE over all turns — the baseline's
 * own exploration to rediscover the rule is therefore counted, not just the final prompt. Falls
 * back to treating the raw text as the transcript with zero usage when it isn't json.
 */
export function parseAgentJson(stdout: string): AgentUsage {
  const trimmed = stdout.trim();
  try {
    const obj = JSON.parse(trimmed) as {
      result?: string;
      total_cost_usd?: number;
      num_turns?: number;
      modelUsage?: Record<
        string,
        {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
        }
      >;
    };
    let tokensIn = 0;
    let tokensOut = 0;
    for (const u of Object.values(obj.modelUsage ?? {})) {
      tokensIn += (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
      tokensOut += u.outputTokens ?? 0;
    }
    return {
      out: obj.result ?? trimmed,
      tokensIn,
      tokensOut,
      costUsd: obj.total_cost_usd ?? 0,
      numTurns: obj.num_turns ?? 0,
    };
  } catch {
    return { out: stdout, tokensIn: 0, tokensOut: 0, costUsd: 0, numTurns: 0 };
  }
}

// ───────────────────────── distractor seeding (E4) ─────────────────────────

/** A pool of plausible-but-unrelated repo preferences used to grow memory with noise. */
const DISTRACTOR_POOL: string[] = [
  "prefer named exports over default exports across the codebase",
  "log timing for any operation that exceeds 200 milliseconds",
  "keep public functions under 40 lines where practical",
  "use ISO 8601 strings for all serialized timestamps",
  "validate external input with zod at module boundaries",
  "avoid abbreviations in identifiers except well-known ones like id and url",
  "co-locate unit tests next to the file they cover",
  "prefer async/await over raw promise chains",
  "wrap third-party clients behind a thin internal adapter",
  "use kebab-case for new file names",
  "emit structured json logs rather than free-form strings",
  "guard every network call with an explicit timeout",
  "keep configuration in one typed module, never scattered env reads",
  "prefer composition over inheritance for new abstractions",
  "document non-obvious invariants with a short comment, nothing more",
  "use UTC everywhere internally and convert only at the edges",
  "fail fast on programmer error, recover only at system boundaries",
  "batch database writes when more than five rows change at once",
  "never swallow errors silently; rethrow or log with context",
  "prefer Map over plain objects for dynamic keyed collections",
  "keep CLI flags long-form in scripts for readability",
  "memoize pure functions that are hot on the render path",
  "use early returns to keep nesting shallow",
  "treat warnings as errors in CI builds",
  "prefer immutable updates over in-place mutation of shared state",
  "name booleans with an is/has/should prefix",
  "keep PR descriptions focused on the why, not the what",
  "pin exact versions for build-critical dependencies",
  "prefer streaming over buffering for large payloads",
  "centralize retry policy instead of re-implementing per call site",
];

function distractorId(text: string): string {
  return createHash("sha1").update(text.trim().toLowerCase()).digest("hex").slice(0, 12);
}

/**
 * Seed N synthetic approved preferences into `.gps/preferences.yml`, MERGING with whatever the
 * teach step already captured (the real rule must survive). Only meaningful when the arm has a
 * `.gps/` at all. Writes valid Preference records (source: manual = approved-equivalent).
 */
export async function seedDistractors(repo: string, n: number): Promise<void> {
  if (n <= 0) return;
  const file = path.join(repo, ".gps", "preferences.yml");
  let existing: unknown[] = [];
  try {
    const parsed = parseYaml(await readFile(file, "utf8"));
    if (Array.isArray(parsed)) existing = parsed;
  } catch {
    /* no preferences yet — the merge just becomes the distractor list */
  }
  const now = new Date().toISOString();
  const seen = new Set(
    existing.map((p) => (p as { id?: string }).id).filter((id): id is string => typeof id === "string"),
  );
  for (let i = 0; i < n; i++) {
    const text = DISTRACTOR_POOL[i % DISTRACTOR_POOL.length]!;
    // Disambiguate once the pool wraps so ids stay unique and the count is honest.
    const unique = i < DISTRACTOR_POOL.length ? text : `${text} (variant ${Math.floor(i / DISTRACTOR_POOL.length)})`;
    const id = distractorId(unique);
    if (seen.has(id)) continue;
    seen.add(id);
    existing.push({
      id,
      text: unique,
      scope: "repo",
      topic: "distractor",
      source: "manual",
      recorded_at: now,
      hits: 0,
    });
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stringifyYaml(existing));
}

// ───────────────────────── live execution (operator-run) ─────────────────────────

async function setMcp(repo: string, enabled: boolean): Promise<void> {
  const file = path.join(repo, ".mcp.json");
  if (enabled) await writeFile(file, JSON.stringify(GPS_MCP_CONFIG, null, 2) + "\n");
  else await rm(file, { force: true });
}

/**
 * Best-effort capture of the gps context the agent would have seen this session (for Surface %).
 * Concatenates `prime` (standing context), `preferences`, and a topic `recall` over the rule's
 * surface markers — so a rule that landed as a note/decision/lesson (not just a preference) can
 * still be detected as surfaced. Each query is independent best-effort; failures are skipped.
 */
async function captureContext(repo: string, mcpEnabled: boolean, rule: Rule): Promise<string> {
  if (!mcpEnabled) return "";
  const query = surfaceMarkers(rule).join(" ") || rule.canonical;
  const probes: string[][] = [
    ["prime", "--root", repo],
    ["preferences", "--root", repo, "--markdown"],
    ["recall", query, "--root", repo],
  ];
  const parts: string[] = [];
  for (const args of probes) {
    try {
      const { stdout } = await exec("gps", args, { timeout: 30_000 });
      parts.push(stdout);
    } catch {
      /* command unavailable / nothing to show — skip */
    }
  }
  return parts.join("\n");
}

interface AgentRun extends AgentUsage {
  timedOut: boolean;
}

async function runAgent(
  repo: string,
  command: string,
  prompt: string,
  timeoutSec: number,
  captureTokens: boolean,
): Promise<AgentRun> {
  const [bin, ...args] = parseShellArgs(command);
  if (!bin) throw new Error(`empty agent command: ${command}`);
  // E6: request json so per-session usage (cumulative tokens + cost + turns) is recoverable.
  const finalArgs = captureTokens ? [...args, "--output-format", "json", prompt] : [...args, prompt];
  const noUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0, numTurns: 0 };
  try {
    const { stdout } = await exec(bin, finalArgs, {
      cwd: repo,
      timeout: timeoutSec * 1000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (captureTokens) return { ...parseAgentJson(stdout), timedOut: false };
    return { out: stdout, ...noUsage, timedOut: false };
  } catch (err) {
    const e = err as { stdout?: string; killed?: boolean };
    if (captureTokens) return { ...parseAgentJson(e.stdout ?? ""), timedOut: e.killed === true };
    return { out: e.stdout ?? "", ...noUsage, timedOut: e.killed === true };
  }
}

/** Execute one (rule, arm, trial) live. Side-effecting; expects `claude` + ANTHROPIC_API_KEY. */
export async function runTrial(
  rule: Rule,
  arm: Arm,
  trial: number,
  repo: string,
  opts: RunOptions,
  judge: JudgeFn,
): Promise<TrialResult> {
  await resetAll(repo);
  // Faithful per-arm setup. Only the gps/unapproved arms get gps at all; baseline and
  // in-context run vanilla (resetAll already cleared `.gps/`, `.mcp.json`, and any installed
  // hooks). `install` wires the lifecycle hooks — incl. UserPromptSubmit → capture-preference /
  // capture-directive, which is what actually records the taught rule. The pilot confirmed this
  // is the path that fires headless; `gps init` alone captures nothing. `--capture inbox` routes
  // captures through the governance gate so the approve step (and the unapproved control) mean
  // something.
  if (arm === "gps" || arm === "unapproved") {
    await exec("gps", ["init", "--root", repo], { timeout: 60_000 }).catch(() => undefined);
    await exec("gps", ["install", "claude", "--capture", "inbox", "--root", repo], {
      timeout: 60_000,
    }).catch(() => undefined);
    await exec("gps", ["index", "--root", repo], { timeout: 120_000 }).catch(() => undefined);
  }

  const sessions: SessionResult[] = [];
  const steps = planTrial(rule, arm, { ...opts, trials: trial });

  for (const step of steps) {
    if (step.phase === "approve") {
      if (step.approveInbox) {
        // `inbox approve` is per-id; list pending items as JSON and approve each.
        try {
          const { stdout } = await exec("gps", ["inbox", "list", "--json", "--root", repo], {
            timeout: 30_000,
          });
          const items = JSON.parse(stdout) as Array<{ id?: string }>;
          for (const it of items) {
            if (it.id) {
              await exec("gps", ["inbox", "approve", it.id, "--root", repo], {
                timeout: 30_000,
              }).catch(() => undefined);
            }
          }
        } catch {
          /* nothing queued / inbox unavailable — best effort */
        }
      }
      // E4: grow memory with decoys AFTER approval but BEFORE the fresh test sessions, so the
      // test measures whether recall still surfaces the right rule among the noise.
      if (opts.distractors > 0) await seedDistractors(repo, opts.distractors);
      continue;
    }

    if (step.memoryWiped) await wipeMemory(repo);
    await setMcp(repo, step.mcpEnabled);
    const t0 = Date.now();
    const run = await runAgent(repo, opts.agentCommand, step.prompt!, opts.timeoutSec, opts.captureTokens);
    const duration = (Date.now() - t0) / 1000;
    const context = step.phase === "test" ? await captureContext(repo, step.mcpEnabled, rule) : "";

    const session: SessionResult = {
      arm,
      rule_id: rule.id,
      trial,
      session_index: step.session_index,
      phase: step.phase,
      transcript: run.out,
      context,
      duration_sec: duration,
      timed_out: run.timedOut,
      tokens_in: run.tokensIn,
      tokens_out: run.tokensOut,
      cost_usd: run.costUsd,
      num_turns: run.numTurns,
    };
    if (step.phase === "test") {
      session.grade = await gradeSession({
        rule,
        repo,
        transcript: run.out,
        context: step.ruleInjected ? rule.canonical + "\n" + context : context,
        judges: opts.judges,
        judge,
      });
    }
    sessions.push(session);
    if (step.phase === "test") await resetCodeOnly(repo);
  }
  return { arm, rule_id: rule.id, trial, sessions };
}

// ───────────────────────────────── CLI ─────────────────────────────────

interface CliArgs {
  rulesDir: string;
  repo: string;
  trials: number;
  sessions: number;
  arms: Arm[];
  planOnly: boolean;
  out: string;
  distractors: number;
  captureTokens: boolean;
  judges: number;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string, dflt?: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
  };
  const armsRaw = get("--arms");
  return {
    rulesDir: get("--rules", "bench/memory/rules/ky")!,
    repo: get("--repo", "")!,
    trials: Number(get("--trials", "3")),
    sessions: Number(get("--sessions", "2")),
    arms: armsRaw ? (armsRaw.split(",") as Arm[]) : [...ALL_ARMS],
    planOnly: argv.includes("--plan-only"),
    out: get("--out", `bench/memory/results/${new Date().toISOString().slice(0, 10)}`)!,
    distractors: Number(get("--distractors", "0")),
    captureTokens: argv.includes("--capture-tokens"),
    judges: Number(get("--judges", String(DEFAULT_RUN_OPTIONS.judges))),
  };
}

function printPlan(rules: Rule[], arms: Arm[], opts: RunOptions): void {
  for (const rule of rules) {
    console.log(`\n# rule ${rule.id} (${rule.type}) — ${rule.canonical}`);
    for (const arm of arms) {
      console.log(`\n  ## arm: ${arm}`);
      for (const step of planTrial(rule, arm, opts)) {
        const flags = [
          step.mcpEnabled ? "mcp" : "no-mcp",
          step.memoryWiped ? "memory-wiped" : "memory-kept",
          step.ruleInjected ? "rule-injected" : "no-inject",
          step.phase === "approve" ? (step.approveInbox ? "APPROVE" : "leave-in-inbox") : "",
        ]
          .filter(Boolean)
          .join(", ");
        console.log(`   - S${step.session_index} ${step.phase.padEnd(7)} [${flags}]`);
        if (step.prompt) console.log(`       prompt: ${JSON.stringify(step.prompt)}`);
        if (step.note) console.log(`       note: ${step.note}`);
      }
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const opts: RunOptions = {
    ...DEFAULT_RUN_OPTIONS,
    trials: args.trials,
    testSessions: args.sessions,
    arms: args.arms,
    distractors: args.distractors,
    captureTokens: args.captureTokens,
    judges: args.judges,
  };
  const rules = await loadRules(args.rulesDir);
  console.error(`loaded ${rules.length} rule(s) from ${args.rulesDir}; arms: ${args.arms.join(", ")}`);

  if (args.planOnly) {
    printPlan(rules, args.arms, opts);
    return;
  }

  if (!args.repo) throw new Error("--repo <path> is required for a live run (the target working copy).");
  if (!(await isClaudeAvailable())) {
    throw new Error("`claude` CLI not available. Live runs need it + ANTHROPIC_API_KEY. Use --plan-only to inspect offline.");
  }

  await mkdir(args.out, { recursive: true });
  const all: TrialResult[] = [];
  for (const rule of rules) {
    for (const arm of args.arms) {
      for (let t = 0; t < args.trials; t++) {
        console.error(`run ${rule.id} / ${arm} / trial ${t}`);
        const result = await runTrial(rule, arm, t, args.repo, opts, defaultJudge);
        all.push(result);
        await writeFile(
          path.join(args.out, `${rule.id}.${arm}.${t}.json`),
          JSON.stringify(result, null, 2),
        );
      }
    }
  }
  await writeFile(path.join(args.out, "trials.json"), JSON.stringify(all, null, 2));
  console.error(`wrote ${all.length} trial result(s) to ${args.out}`);
}

// Run only when invoked directly (not when imported by tests).
const isMain = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
