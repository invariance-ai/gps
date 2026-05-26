/**
 * Aggregation math for the memory benchmark. Reuses the Wilson CI from gps-core so the
 * proportion intervals match the rest of the bench suite; adds a bootstrap CI for means
 * and Cohen's kappa for inter-judge agreement.
 */
import { wilson, type WilsonCI } from "@invariance/gps-core";
import type { SessionResult, Arm } from "./types.js";

export interface Proportion {
  hits: number;
  n: number;
  rate: number;
  ci: WilsonCI;
}

function proportion(hits: number, n: number): Proportion {
  return { hits, n, rate: n === 0 ? 0 : hits / n, ci: wilson(hits, n) };
}

/** Only test-phase, graded sessions count toward the headline metrics. */
function gradedTests(sessions: SessionResult[]): SessionResult[] {
  return sessions.filter((s) => s.phase === "test" && s.grade !== undefined);
}

/** Surface %: of test sessions, how many had the taught rule in the agent's context. */
export function surfaceRate(sessions: SessionResult[]): Proportion {
  const t = gradedTests(sessions);
  return proportion(t.filter((s) => s.grade!.surfaced).length, t.length);
}

/** Adherence %: of test sessions where adherence was applicable, how many honored the rule. */
export function adherenceRate(sessions: SessionResult[]): Proportion {
  const t = gradedTests(sessions).filter((s) => s.grade!.honored !== null);
  return proportion(t.filter((s) => s.grade!.honored === true).length, t.length);
}

/** Rediscovery rate (B2): of test sessions, how many re-proposed the rejected alternative. */
export function rediscoveryRate(sessions: SessionResult[]): Proportion {
  const t = gradedTests(sessions);
  return proportion(t.filter((s) => s.grade!.rediscovered).length, t.length);
}

/**
 * Leakage (B5 negative control): the count of UNAPPROVED-arm test sessions that nonetheless
 * surfaced or honored the rule. MUST be 0 — an unapproved memory must not steer the agent.
 */
export function leakage(sessions: SessionResult[]): number {
  return gradedTests(sessions).filter(
    (s) => s.arm === "unapproved" && (s.grade!.surfaced || s.grade!.honored === true),
  ).length;
}

/** Split a flat session list by arm (convenience for per-arm rollups). */
export function byArm(sessions: SessionResult[]): Record<Arm, SessionResult[]> {
  const out: Record<Arm, SessionResult[]> = {
    gps: [],
    baseline: [],
    "in-context": [],
    unapproved: [],
  };
  for (const s of sessions) out[s.arm].push(s);
  return out;
}

/** Percentile bootstrap CI for the mean of a sample (default 95%, 2000 resamples). */
export function bootstrapMeanCI(
  values: number[],
  opts: { iters?: number; alpha?: number; seed?: number } = {},
): { mean: number; lo: number; hi: number } {
  const { iters = 2000, alpha = 0.05 } = opts;
  const n = values.length;
  if (n === 0) return { mean: 0, lo: 0, hi: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  // Deterministic LCG so reported CIs are reproducible.
  let state = (opts.seed ?? 12345) >>> 0;
  const rand = (): number => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += values[Math.floor(rand() * n)]!;
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor((alpha / 2) * iters)]!;
  const hi = means[Math.min(iters - 1, Math.floor((1 - alpha / 2) * iters))]!;
  return { mean, lo, hi };
}

/**
 * Cohen's kappa for two raters over binary labels (true/false). Used pairwise across the
 * judge panel to report inter-judge agreement beyond chance.
 */
export function cohenKappa(a: boolean[], b: boolean[]): number {
  if (a.length !== b.length || a.length === 0) {
    throw new Error("cohenKappa: rater arrays must be equal, non-zero length");
  }
  const n = a.length;
  let agree = 0;
  let aTrue = 0;
  let bTrue = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree += 1;
    if (a[i]) aTrue += 1;
    if (b[i]) bTrue += 1;
  }
  const po = agree / n;
  const pTrue = (aTrue / n) * (bTrue / n);
  const pFalse = ((n - aTrue) / n) * ((n - bTrue) / n);
  const pe = pTrue + pFalse;
  if (pe === 1) return 1; // perfect chance agreement → kappa undefined; treat as 1
  return (po - pe) / (1 - pe);
}

/** Mean pairwise Cohen's kappa across a panel of judges (each a boolean[] over the same items). */
export function panelKappa(raters: boolean[][]): number {
  if (raters.length < 2) return 1;
  const ks: number[] = [];
  for (let i = 0; i < raters.length; i++) {
    for (let j = i + 1; j < raters.length; j++) {
      ks.push(cohenKappa(raters[i]!, raters[j]!));
    }
  }
  return ks.reduce((a, b) => a + b, 0) / ks.length;
}
