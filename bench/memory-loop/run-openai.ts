import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

interface Args {
  model: string;
  outDir: string;
  keepFixture: boolean;
}

interface ArmResult {
  arm: "baseline" | "gps";
  prompt: string;
  output: string;
  score: Score;
}

interface Score {
  mentionsTests: boolean;
  mentionsGpsMemory: boolean;
  mentionsRightSymbol: boolean;
  mentionsRightFile: boolean;
  points: number;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let model = process.env.OPENAI_MODEL ?? "gpt-5.1-codex-mini";
  let outDir = "";
  let keepFixture = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--model") model = args[++i]!;
    else if (a === "--out-dir") outDir = args[++i]!;
    else if (a === "--keep-fixture") keepFixture = true;
    else if (a === "--help" || a === "-h") {
      console.log(`usage: tsx bench/memory-loop/run-openai.ts [--model gpt-5.1-codex-mini] [--out-dir DIR] [--keep-fixture]`);
      process.exit(0);
    }
  }
  if (!outDir) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    outDir = path.join("bench", "memory-loop", "results", stamp);
  }
  return { model, outDir, keepFixture };
}

async function runGps(repoRoot: string, args: string[], stdin?: string): Promise<string> {
  const cli = path.join(process.cwd(), "packages", "cli", "dist", "index.js");
  const result = await execFile(process.execPath, [cli, ...args, "--root", repoRoot], {
    input: stdin,
    maxBuffer: 1024 * 1024 * 10,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return `${result.stdout}${result.stderr}`.trim();
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-memory-loop-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "gps-memory-loop-fixture",
        private: true,
        type: "module",
        scripts: { test: "vitest run" },
        devDependencies: { vitest: "^2.1.0", typescript: "^5.6.0" },
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    path.join(root, "src", "refunds.ts"),
    [
      "export interface RefundRequest {",
      "  customerTier: 'standard' | 'enterprise';",
      "  amountCents: number;",
      "  reason: string;",
      "}",
      "",
      "export interface RefundResult {",
      "  status: 'approved' | 'needs_approval';",
      "  message: string;",
      "}",
      "",
      "export function createRefund(req: RefundRequest): RefundResult {",
      "  const thresholdCents = req.customerTier === 'enterprise' ? 2000000 : 500000;",
      "  if (req.amountCents > thresholdCents) {",
      "    return {",
      "      status: 'needs_approval',",
      "      message: 'Refund requires manager approval before processing.',",
      "    };",
      "  }",
      "  return { status: 'approved', message: 'Refund approved.' };",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "src", "refunds.test.ts"),
    [
      "import { describe, expect, it } from 'vitest';",
      "import { createRefund } from './refunds.js';",
      "",
      "describe('createRefund', () => {",
      "  it('requires approval for high standard refunds', () => {",
      "    expect(createRefund({ customerTier: 'standard', amountCents: 500001, reason: 'duplicate' }).status)",
      "      .toBe('needs_approval');",
      "  });",
      "});",
      "",
    ].join("\n"),
  );
  return root;
}

async function seedGps(repoRoot: string): Promise<{ plan: string; prepare: string; notes: string }> {
  await runGps(repoRoot, ["init", "--force"]);
  await runGps(repoRoot, ["index", "--quiet"]);
  const plan = await runGps(repoRoot, [
    "plan",
    "Make a small change to createRefund's approval message",
    "--json",
  ]);
  await runGps(repoRoot, [
    "prepare",
    "createRefund",
    "--intent",
    "Change createRefund so non-enterprise refunds above $5000 require approval.",
    "--json",
  ]);
  const transcript = [
    "user: Change createRefund so non-enterprise refunds above $5000 require approval.",
    "",
    "assistant: Done. I updated createRefund.",
    "",
    "user: No, bad Codex, you need to write more tests before calling this done.",
    "",
  ].join("\n");
  await writeFile(path.join(repoRoot, "transcript.txt"), transcript);
  await runGps(repoRoot, [
    "attach",
    "--transcript",
    path.join(repoRoot, "transcript.txt"),
    "--capture-prefs",
    "--symbol",
    "createRefund",
  ]);
  const prepare = await runGps(repoRoot, [
    "prepare",
    "createRefund",
    "--intent",
    "Make a small wording-only change to createRefund's approval message.",
  ]);
  const notes = await runGps(repoRoot, ["notes", "createRefund"]);
  return { plan, prepare, notes };
}

async function callOpenAI(model: string, input: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content:
            "You are Codex planning a small repo edit. Return concise JSON only with keys files_to_open, first_actions, will_add_or_run_tests, rationale.",
        },
        { role: "user", content: input },
      ],
      max_output_tokens: 500,
    }),
  });
  const body = await res.json() as {
    output_text?: string;
    error?: { message?: string };
    output?: Array<{ content?: Array<{ text?: string }> }>;
  };
  if (!res.ok) throw new Error(body.error?.message ?? `OpenAI request failed: ${res.status}`);
  return (
    body.output_text ??
    body.output?.flatMap((o) => o.content ?? []).map((c) => c.text ?? "").join("") ??
    ""
  ).trim();
}

function score(output: string): Score {
  const text = output.toLowerCase();
  let parsed: { will_add_or_run_tests?: unknown } | undefined;
  try {
    parsed = JSON.parse(output) as { will_add_or_run_tests?: unknown };
  } catch {
    /* model output can still be scored heuristically */
  }
  const testsField = String(parsed?.will_add_or_run_tests ?? "").toLowerCase();
  const explicitlySkipsTests = /\b(no|false|not|without|skip|unnecessary)\b/.test(testsField);
  const explicitlyPlansTests = /\b(yes|true|run|add|update|strengthen|cover|coverage|test|tests|spec|assert)\b/.test(testsField) &&
    !explicitlySkipsTests;
  const mentionsTests = explicitlyPlansTests ||
    (!testsField && /\b(run|add|update|strengthen|cover)\b.{0,60}\b(test|tests|coverage|spec|assert)\b/.test(text));
  const mentionsGpsMemory =
    /\b(gps|prior|previous|correction|memory|note|lesson)\b/.test(text) ||
    /\badd or strengthen tests\b/.test(text) ||
    /\bper instruction\b/.test(text);
  const mentionsRightSymbol = /\bcreaterefund\b/.test(text);
  const mentionsRightFile = /\bsrc\/refunds(\.test)?\.ts\b/.test(text) || /\brefunds(\.test)?\.ts\b/.test(text);
  return {
    mentionsTests,
    mentionsGpsMemory,
    mentionsRightSymbol,
    mentionsRightFile,
    points:
      (mentionsTests ? 2 : 0) +
      (mentionsGpsMemory ? 1 : 0) +
      (mentionsRightSymbol ? 1 : 0) +
      (mentionsRightFile ? 1 : 0),
  };
}

function renderPrompt(arm: "baseline" | "gps", context: string): string {
  const base = [
    "Task: Make a small wording-only change to createRefund's approval message.",
    "",
    "Repo files:",
    "- src/refunds.ts contains createRefund.",
    "- src/refunds.test.ts contains createRefund tests.",
    "",
  ].join("\n");
  if (arm === "baseline") {
    return base + "No cross-session GPS memory is available. Plan the edit.";
  }
  return [
    base,
    "GPS context is available below. Use it exactly like a pre-edit brief from `gps prepare`.",
    "",
    context,
    "",
    "Plan the edit.",
  ].join("\n");
}

function renderSummary(args: Args, fixtureRoot: string, results: ArmResult[], gpsContext: string): string {
  const gps = results.find((r) => r.arm === "gps")!;
  const baseline = results.find((r) => r.arm === "baseline")!;
  return [
    "# OpenAI memory-loop experiment",
    "",
    `- Model: \`${args.model}\``,
    `- Fixture: \`${fixtureRoot}\`${args.keepFixture ? "" : " (deleted after run)"}`,
    `- Baseline score: ${baseline.score.points}/5`,
    `- GPS score: ${gps.score.points}/5`,
    `- GPS surfaced testing correction: ${/\badd or strengthen tests\b/i.test(gpsContext) ? "yes" : "no"}`,
    "",
    "## Scores",
    "",
    "| Arm | Tests | GPS memory | Symbol | File | Points |",
    "|---|---:|---:|---:|---:|---:|",
    ...results.map((r) =>
      `| ${r.arm} | ${r.score.mentionsTests ? "yes" : "no"} | ${r.score.mentionsGpsMemory ? "yes" : "no"} | ${r.score.mentionsRightSymbol ? "yes" : "no"} | ${r.score.mentionsRightFile ? "yes" : "no"} | ${r.score.points} |`,
    ),
    "",
    "## Baseline Output",
    "",
    "```json",
    baseline.output,
    "```",
    "",
    "## GPS Output",
    "",
    "```json",
    gps.output,
    "```",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const fixtureRoot = await createFixture();
  let cleanup = !args.keepFixture;
  try {
    const gpsSeed = await seedGps(fixtureRoot);
    const gpsContext = [
      "## gps plan --json",
      gpsSeed.plan,
      "",
      "## gps prepare createRefund",
      gpsSeed.prepare,
      "",
      "## gps notes createRefund",
      gpsSeed.notes,
    ].join("\n");

    const prompts = {
      baseline: renderPrompt("baseline", ""),
      gps: renderPrompt("gps", gpsContext),
    };
    const results: ArmResult[] = [];
    for (const arm of ["baseline", "gps"] as const) {
      process.stdout.write(`running ${arm} with ${args.model}... `);
      const output = await callOpenAI(args.model, prompts[arm]);
      const scored = score(output);
      results.push({ arm, prompt: prompts[arm], output, score: scored });
      console.log(`${scored.points}/5`);
    }

    await mkdir(args.outDir, { recursive: true });
    await writeFile(
      path.join(args.outDir, "result.json"),
      JSON.stringify(
        {
          version: 1,
          generated_at: new Date().toISOString(),
          model: args.model,
          fixture_root: fixtureRoot,
          fixture_retained: args.keepFixture,
          gps_context: gpsContext,
          results,
        },
        null,
        2,
      ) + "\n",
    );
    await writeFile(path.join(args.outDir, "summary.md"), renderSummary(args, fixtureRoot, results, gpsContext));
    console.log(`wrote ${args.outDir}`);
  } catch (e) {
    cleanup = false;
    console.error((e as Error).message);
    console.error(`fixture kept for debugging: ${fixtureRoot}`);
    process.exitCode = 1;
  } finally {
    if (cleanup) await rm(fixtureRoot, { recursive: true, force: true });
  }
}

main();
