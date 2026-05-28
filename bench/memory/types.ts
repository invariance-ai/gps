/**
 * Types for the cross-session memory benchmark (see scratch.md design doc + the
 * plan at ~/.claude/plans/give-file-path-for-zazzy-comet.md).
 *
 * The benchmark measures whether a correction taught in one session is reused by a
 * FRESH session with zero carried context — the one thing that is uniquely gps.
 */

/** The four experimental arms. Only the persistence/injection setup varies. */
export type Arm = "gps" | "baseline" | "in-context" | "unapproved";
export const ALL_ARMS: readonly Arm[] = ["gps", "baseline", "in-context", "unapproved"] as const;

export type RuleType = "preference" | "directive" | "decision" | "lesson";

export interface AdherenceCheck {
  /** "grep" → `expect` is a shell command run via `sh -c` in the repo, exit 0 = honored. */
  /** "judge" → `expect` is a natural-language criterion for the blind LLM judge. */
  kind: "grep" | "judge";
  expect: string;
}

/** One rule in the bank. Authored once, taught via a paraphrase, tested without restatement. */
export interface Rule {
  id: string;
  type: RuleType;
  /** Canonical statement of the rule. NEVER shown to the agent verbatim except in the in-context arm. */
  canonical: string;
  /** Natural paraphrases; the developer-sim teaches with ONE of these (not the canonical). */
  paraphrases: string[];
  /** The fresh-session task that puts the rule in tension, WITHOUT restating it. */
  test_task: string;
  adherence_check: AdherenceCheck;
  /** Why honoring the rule requires an active change (so "honored" is observable, not vacuous). */
  tension: string;
  /** Symbol the rule concerns (decision/lesson rules) — used for B2/B4 and surfacing. */
  symbol?: string;
  /** For decision-type rules: the rejected alternative (B2 rediscovery rate). */
  rejected?: string;
  /**
   * Substrings whose presence in the agent's injected context counts as the rule being
   * "surfaced". Defaults (when omitted) to the significant tokens of `canonical`.
   */
  surface_markers?: string[];
}

/** Result of grading one test session. */
export interface SessionGrade {
  /** Did the taught rule appear in the agent's gps context this session? (Surface %) */
  surfaced: boolean;
  /** Did the produced diff/plan comply with the rule? null = not applicable / judge abstained. */
  honored: boolean | null;
  /** For decision rules: did the agent re-propose the rejected alternative? (Rediscovery) */
  rediscovered: boolean;
  /** Per-judge raw verdicts when the judge panel was used (empty for deterministic grep checks). */
  judge_votes: ("honored" | "violated" | "NA")[];
}

export interface SessionResult {
  arm: Arm;
  rule_id: string;
  trial: number;
  /** 0 = teach session; 1..k = test sessions. */
  session_index: number;
  phase: "teach" | "test";
  transcript: string;
  /** gps context the agent saw this session (hook injection / preferences / prepare output). */
  context: string;
  grade?: SessionGrade;
  duration_sec: number;
  timed_out: boolean;
  /**
   * Honest end-to-end usage for this session, parsed from `claude -p --output-format json`.
   * Cumulative across all turns/sub-models (summed from `modelUsage`), so the baseline's own
   * exploration (greps/file reads to rediscover the rule) is counted — not just the final prompt.
   * Zero when the agent command does not emit json usage. (E6 token accounting.)
   */
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  /** Turns the agent took — a proxy for exploration effort (baseline rediscovers, so does more). */
  num_turns?: number;
}

export interface TrialResult {
  arm: Arm;
  rule_id: string;
  trial: number;
  sessions: SessionResult[];
}

/** A single planned step — the deterministic, offline-inspectable unit (`--plan-only`). */
export interface PlannedStep {
  phase: "teach" | "approve" | "test";
  arm: Arm;
  rule_id: string;
  trial: number;
  session_index: number;
  /** The user message handed to the agent (teach/test). undefined for the approve checkpoint. */
  prompt?: string;
  /** Is `.mcp.json` (GPS_MCP_CONFIG) present — i.e. does the agent have gps tools this session? */
  mcpEnabled: boolean;
  /** baseline wipes `.gps/` before each test session so nothing carries forward. */
  memoryWiped: boolean;
  /** in-context injects the canonical rule text directly into the test prompt (the ceiling). */
  ruleInjected: boolean;
  /** Do we run `gps inbox approve` after teach? (gps + in-context: yes; unapproved: no — the gate test.) */
  approveInbox: boolean;
  note?: string;
}

export interface RunOptions {
  trials: number;
  /** Number of TEST sessions per trial (k). */
  testSessions: number;
  arms: readonly Arm[];
  /** Agent command, default "claude -p" (parsed via parseShellArgs). */
  agentCommand: string;
  timeoutSec: number;
  /** Number of blind judges in the adherence panel. */
  judges: number;
  /**
   * E4: number of synthetic decoy artifacts seeded into `.gps/` after teach+approve, before the
   * test sessions, to test whether recall still surfaces the RIGHT rule as memory grows. Only the
   * gps/unapproved arms (which have a `.gps/`) are affected; 0 = off.
   */
  distractors: number;
  /**
   * E6: request `--output-format json` from the agent so per-session token/cost usage is captured.
   * Off keeps the legacy plain-text transcript path.
   */
  captureTokens: boolean;
}

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  trials: 3,
  testSessions: 2,
  arms: ALL_ARMS,
  agentCommand: "claude -p",
  timeoutSec: 300,
  judges: 3,
  distractors: 0,
  captureTokens: false,
};
