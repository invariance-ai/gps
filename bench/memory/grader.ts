/**
 * Blind, deterministic-first grading.
 *
 * - Adherence: if the rule has a `grep` check, run it in the repo (unarguable). Otherwise a
 *   blind LLM-judge panel (mirrors bench/perf/accuracy.ts's claude -p pattern) votes
 *   honored/violated/NA — the panel is blind to arm.
 * - Surface: does the taught rule appear in the gps context the agent saw this session.
 * - Rediscovery: for decision rules, did the agent re-propose the rejected alternative.
 *
 * The model call is injected (`JudgeFn`) so the whole grader is unit-testable without network.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Rule, SessionGrade } from "./types.js";

const exec = promisify(execFile);

export type Verdict = "honored" | "violated" | "NA";
export type JudgeFn = (prompt: string) => Promise<string>;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "are", "not",
  "use", "used", "when", "always", "never", "should", "must", "going", "forward",
]);

/** Surface markers for a rule: explicit if given, else the significant tokens of `canonical`. */
export function surfaceMarkers(rule: Rule): string[] {
  if (rule.surface_markers && rule.surface_markers.length > 0) return rule.surface_markers;
  return rule.canonical
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

/** Surfaced iff every marker appears (case-insensitive) in the agent's context for the session. */
export function isSurfaced(context: string, rule: Rule): boolean {
  const hay = context.toLowerCase();
  const markers = surfaceMarkers(rule);
  if (markers.length === 0) return false;
  return markers.every((m) => hay.includes(m.toLowerCase()));
}

/** Decision-rule rediscovery: the rejected alternative re-proposed in the agent's output. */
export function detectRediscovery(transcript: string, rule: Rule): boolean {
  if (!rule.rejected) return false;
  return transcript.toLowerCase().includes(rule.rejected.toLowerCase());
}

/** Deterministic adherence via a shell check run in the repo (exit 0 = honored). */
export async function gradeGrep(repo: string, command: string): Promise<boolean> {
  try {
    await exec("sh", ["-c", command], { cwd: repo, timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

/** Blind judge prompt — never mentions which arm produced the transcript. */
export function buildJudgePrompt(rule: Rule, transcript: string): string {
  return [
    "You are grading whether an engineering change complies with a stated rule. Be strict and literal.",
    "",
    `Rule: ${rule.canonical}`,
    `What "honored" requires: ${rule.adherence_check.expect}`,
    "",
    "Agent output (plan and/or diff):",
    '"""',
    transcript.slice(0, 8000),
    '"""',
    "",
    'Respond with ONLY one JSON object, no prose: {"verdict":"honored"|"violated"|"NA","why":"<short>"}.',
    'Use "NA" only if the output does not address the rule\'s subject at all.',
  ].join("\n");
}

export function parseVerdict(raw: string): Verdict {
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const v = (JSON.parse(m[0]) as { verdict?: unknown }).verdict;
      if (v === "honored" || v === "violated" || v === "NA") return v;
    } catch {
      /* fall through to keyword scan */
    }
  }
  if (/\bhonored\b/i.test(raw)) return "honored";
  if (/\bviolated\b/i.test(raw)) return "violated";
  return "NA";
}

function majority(votes: Verdict[]): boolean | null {
  let honored = 0;
  let violated = 0;
  for (const v of votes) {
    if (v === "honored") honored += 1;
    else if (v === "violated") violated += 1;
  }
  if (honored === 0 && violated === 0) return null; // all NA
  if (honored === violated) return null; // tie → abstain, log for adjudication
  return honored > violated;
}

/** Run an N-judge blind panel; returns the majority verdict and raw votes. */
export async function judgeAdherence(
  rule: Rule,
  transcript: string,
  opts: { judges: number; judge: JudgeFn },
): Promise<{ honored: boolean | null; votes: Verdict[] }> {
  const prompt = buildJudgePrompt(rule, transcript);
  const votes: Verdict[] = [];
  for (let i = 0; i < opts.judges; i++) {
    votes.push(parseVerdict(await opts.judge(prompt)));
  }
  return { honored: majority(votes), votes };
}

/** Grade one test session end to end. Uses grep when available, else the judge panel. */
export async function gradeSession(args: {
  rule: Rule;
  repo: string;
  transcript: string;
  context: string;
  judges: number;
  judge: JudgeFn;
}): Promise<SessionGrade> {
  const { rule, repo, transcript, context, judges, judge } = args;
  const surfaced = isSurfaced(context, rule);
  const rediscovered = detectRediscovery(transcript, rule);

  if (rule.adherence_check.kind === "grep") {
    const honored = await gradeGrep(repo, rule.adherence_check.expect);
    return { surfaced, honored, rediscovered, judge_votes: [] };
  }
  const { honored, votes } = await judgeAdherence(rule, transcript, { judges, judge });
  return { surfaced, honored, rediscovered, judge_votes: votes };
}

/** Is the `claude` CLI available for live judging? (Mirrors accuracy.ts's check.) */
export async function isClaudeAvailable(): Promise<boolean> {
  try {
    await exec("claude", ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Default live judge: spawn `claude -p --output-format text`, prompt on stdin (60s cap). */
export const defaultJudge: JudgeFn = (prompt) =>
  new Promise<string>((resolve) => {
    const child = spawn("claude", ["-p", "--output-format", "text"], { env: process.env });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(out);
    }, 60_000);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
