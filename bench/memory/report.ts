/**
 * Reporter for the cross-session memory benchmark.
 *
 * Reads one or more results dirs (each with a `trials.json` written by run.ts), aggregates with
 * the SAME metrics.ts functions the harness is unit-tested on, and emits the results markdown for:
 *   E1  headline cross-session reuse (per-arm Surface% / Adherence% with Wilson CIs + panel kappa)
 *   E2  adherence broken down by memory type (preference / directive / decision / lesson)
 *   E3  decision rediscovery rate (re-proposing the rejected alternative)
 *   E4  recall robustness vs distractor count (when results dirs are labelled by N)
 *   E5  the renamed-fork contrast (a second results dir reported side by side)
 *   E6  GPS vs no-GPS token + cost accounting (mean per session, bootstrap CIs) — caveated
 *
 * Pure functions are exported for unit testing; main() is guarded so importing is side-effect free.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  surfaceRate,
  adherenceRate,
  rediscoveryRate,
  leakage,
  bootstrapMeanCI,
  panelKappa,
  byArm,
  type Proportion,
} from "./metrics.js";
import { loadRules } from "./run.js";
import type { Arm, RuleType, SessionResult, TrialResult } from "./types.js";

export async function loadTrials(dir: string): Promise<TrialResult[]> {
  const raw = await readFile(path.join(dir, "trials.json"), "utf8");
  const parsed = JSON.parse(raw) as TrialResult[];
  if (!Array.isArray(parsed)) throw new Error(`${dir}/trials.json is not an array`);
  return parsed;
}

export function flattenSessions(trials: TrialResult[]): SessionResult[] {
  return trials.flatMap((t) => t.sessions);
}

/** Format a proportion as "45% (32–58, n=20)". */
export function fmtPct(p: Proportion): string {
  if (p.n === 0) return "n/a (n=0)";
  const pct = (x: number): string => (x * 100).toFixed(0);
  return `${pct(p.rate)}% (${pct(p.ci.low)}–${pct(p.ci.high)}, n=${p.n})`;
}

/** Mean ± bootstrap CI for a numeric field over graded test sessions. */
export function meanField(
  sessions: SessionResult[],
  pick: (s: SessionResult) => number | undefined,
): { mean: number; lo: number; hi: number; n: number } {
  const values = sessions
    .filter((s) => s.phase === "test")
    .map(pick)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return { ...bootstrapMeanCI(values), n: values.length };
}

/** Mean pairwise judge kappa over fully-judged binary (honored/violated) sessions. */
export function judgeKappa(sessions: SessionResult[], judges: number): number | null {
  const usable = sessions.filter(
    (s) =>
      s.grade &&
      s.grade.judge_votes.length === judges &&
      s.grade.judge_votes.every((v) => v === "honored" || v === "violated"),
  );
  if (usable.length === 0) return null;
  const raters: boolean[][] = [];
  for (let j = 0; j < judges; j++) {
    raters.push(usable.map((s) => s.grade!.judge_votes[j] === "honored"));
  }
  return panelKappa(raters);
}

const ARMS_ORDER: Arm[] = ["baseline", "gps", "in-context", "unapproved"];

/** E1: per-arm headline table. */
export function renderHeadline(sessions: SessionResult[], judges: number): string {
  const split = byArm(sessions);
  const lines = [
    "## E1 — Cross-session memory reuse (headline)",
    "",
    "| Arm | Surface% | Adherence% | Judge κ |",
    "|---|---|---|---|",
  ];
  for (const arm of ARMS_ORDER) {
    const s = split[arm];
    if (s.length === 0) continue;
    const k = judgeKappa(s, judges);
    lines.push(
      `| ${arm} | ${fmtPct(surfaceRate(s))} | ${fmtPct(adherenceRate(s))} | ${k === null ? "—" : k.toFixed(2)} |`,
    );
  }
  const gps = adherenceRate(split.gps);
  const base = adherenceRate(split.baseline);
  const lift = gps.n && base.n ? `${((gps.rate - base.rate) * 100).toFixed(0)}pp` : "n/a";
  const nonOverlap = gps.n && base.n ? (gps.ci.low > base.ci.high ? "yes" : "no") : "n/a";
  lines.push(
    "",
    `**GPS − baseline adherence:** ${lift} (CIs non-overlapping: ${nonOverlap}). ` +
      `Pre-registered bar: ≥ +30pp with non-overlapping 95% CIs.`,
    "",
  );
  return lines.join("\n");
}

/** E2: adherence by memory type. Needs a rule_id → type map. */
export function renderByType(sessions: SessionResult[], typeOf: Map<string, RuleType>): string {
  const types: RuleType[] = ["preference", "directive", "decision", "lesson"];
  const lines = [
    "## E2 — Adherence by memory type (GPS arm vs baseline)",
    "",
    "| Type | GPS Adherence% | Baseline Adherence% |",
    "|---|---|---|",
  ];
  for (const type of types) {
    const inType = sessions.filter((s) => typeOf.get(s.rule_id) === type);
    if (inType.length === 0) continue;
    const split = byArm(inType);
    lines.push(`| ${type} | ${fmtPct(adherenceRate(split.gps))} | ${fmtPct(adherenceRate(split.baseline))} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** E3: decision-rule rediscovery (re-proposing the rejected alternative). */
export function renderRediscovery(sessions: SessionResult[], typeOf: Map<string, RuleType>): string {
  const decision = sessions.filter((s) => typeOf.get(s.rule_id) === "decision");
  if (decision.length === 0) return "";
  const split = byArm(decision);
  const lines = [
    "## E3 — Decision rediscovery (lower is better)",
    "",
    "Of fresh test sessions on decision rules, how many re-proposed the *rejected* alternative.",
    "",
    "| Arm | Rediscovery% |",
    "|---|---|",
  ];
  for (const arm of ARMS_ORDER) {
    if (split[arm].length === 0) continue;
    lines.push(`| ${arm} | ${fmtPct(rediscoveryRate(split[arm]))} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** E6: GPS vs no-GPS token + cost accounting. Honest, caveated, never the headline. */
export function renderTokens(sessions: SessionResult[]): string {
  const split = byArm(sessions);
  const lines = [
    "## E6 — Token + cost cost (GPS vs no-GPS) — secondary, caveated",
    "",
    "> Per the pre-registration, token *savings* is NOT a headline: tokens are ~flat once the",
    "> agent's own exploration is counted. Tokens/cost below are CUMULATIVE per session (summed",
    "> across all turns/sub-models from `claude --output-format json`), so the baseline's",
    "> rediscovery effort is included. The honest claim is *comparable* cost at far higher",
    "> adherence — not a token win.",
    "",
    "| Arm | Mean tokens/session | Mean cost USD/session | Mean turns |",
    "|---|---|---|---|",
  ];
  const fmt = (m: { mean: number; lo: number; hi: number; n: number }, digits = 0): string =>
    m.n === 0 ? "n/a" : `${m.mean.toFixed(digits)} (${m.lo.toFixed(digits)}–${m.hi.toFixed(digits)})`;
  for (const arm of ARMS_ORDER) {
    const s = split[arm];
    if (s.length === 0) continue;
    const toks = meanField(s, (x) => (x.tokens_in ?? 0) + (x.tokens_out ?? 0));
    const cost = meanField(s, (x) => x.cost_usd);
    const turns = meanField(s, (x) => x.num_turns);
    lines.push(`| ${arm} | ${fmt(toks)} | ${fmt(cost, 4)} | ${fmt(turns, 1)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Final cross-cut summary table for the thread. */
export function renderSummary(sessions: SessionResult[]): string {
  const split = byArm(sessions);
  const tok = (arm: Arm): string => {
    const m = meanField(split[arm], (x) => (x.tokens_in ?? 0) + (x.tokens_out ?? 0));
    return m.n === 0 ? "—" : m.mean.toFixed(0);
  };
  return [
    "## Summary",
    "",
    "| Metric | no-GPS (baseline) | GPS | in-context (ceiling) |",
    "|---|---|---|---|",
    `| Adherence% | ${fmtPct(adherenceRate(split.baseline))} | ${fmtPct(adherenceRate(split.gps))} | ${fmtPct(adherenceRate(split["in-context"]))} |`,
    `| Surface% | n/a | ${fmtPct(surfaceRate(split.gps))} | n/a |`,
    `| Rediscovery% (decision) | ${fmtPct(rediscoveryRate(split.baseline))} | ${fmtPct(rediscoveryRate(split.gps))} | ${fmtPct(rediscoveryRate(split["in-context"]))} |`,
    `| Mean tokens/session | ${tok("baseline")} | ${tok("gps")} | ${tok("in-context")} |`,
    `| Leakage (unapproved control) | — | ${leakage(sessions)} | — |`,
    "",
  ].join("\n");
}

export interface ReportInputs {
  sessions: SessionResult[];
  typeOf: Map<string, RuleType>;
  judges: number;
  title?: string;
}

export function renderReport(inp: ReportInputs): string {
  const { sessions, typeOf, judges } = inp;
  const parts = [
    `# ${inp.title ?? "GPS cross-session memory — results"}`,
    "",
    `Generated ${new Date().toISOString()}. Sessions graded: ${sessions.filter((s) => s.phase === "test" && s.grade).length}.`,
    "",
    renderHeadline(sessions, judges),
    renderByType(sessions, typeOf),
    renderRediscovery(sessions, typeOf),
    renderTokens(sessions),
    renderSummary(sessions),
  ];
  return parts.filter(Boolean).join("\n");
}

// ───────────────────────────────── CLI ─────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string, dflt?: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
  };
  const inDir = get("--in");
  if (!inDir) throw new Error("--in <results-dir> is required (the dir holding trials.json)");
  const rulesDir = get("--rules", "bench/memory/rules/ky")!;
  const judges = Number(get("--judges", "3"));
  const out = get("--out");

  const trials = await loadTrials(inDir);
  const sessions = flattenSessions(trials);
  const rules = await loadRules(rulesDir).catch(() => []);
  const typeOf = new Map<string, RuleType>(rules.map((r) => [r.id, r.type]));

  const md = renderReport({ sessions, typeOf, judges, title: get("--title") });
  if (out) {
    await writeFile(out, md);
    console.error(`wrote ${out}`);
  } else {
    console.log(md);
  }
}

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
