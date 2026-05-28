import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

import { parse as parseYamlTest } from "yaml";
import { planTrial, loadRules, validateRule, parseAgentJson, seedDistractors } from "./run.js";
import {
  fmtPct,
  meanField,
  judgeKappa,
  flattenSessions,
  renderReport,
  renderHeadline,
  renderTokens,
} from "./report.js";
import { pickParaphrase, teachPrompt, testPrompt } from "./developer-sim.js";
import {
  isSurfaced,
  surfaceMarkers,
  detectRediscovery,
  parseVerdict,
  judgeAdherence,
  gradeGrep,
  type JudgeFn,
} from "./grader.js";
import {
  surfaceRate,
  adherenceRate,
  leakage,
  rediscoveryRate,
  cohenKappa,
  panelKappa,
  bootstrapMeanCI,
} from "./metrics.js";
import { resetCodeOnly, wipeMemory } from "./reset.js";
import {
  DEFAULT_RUN_OPTIONS,
  type Rule,
  type RuleType,
  type SessionResult,
  type TrialResult,
  type Arm,
} from "./types.js";

const exec = promisify(execFile);

const RULE: Rule = {
  id: "retry-cap-30s",
  type: "preference",
  canonical: "Cap computed retry backoff at 30 seconds.",
  paraphrases: ["don't let backoff exceed 30s", "clamp the backoff to 30 seconds"],
  test_task: "Revisit retry defaults and propose new ones.",
  adherence_check: { kind: "judge", expect: "Backoff is clamped to 30000ms." },
  tension: "default is unbounded",
  surface_markers: ["backoff", "30"],
};

const DECISION: Rule = {
  id: "default-timeout-10s",
  type: "decision",
  symbol: "timeout",
  canonical: "Default request timeout should be 10 seconds.",
  rejected: "no default timeout",
  paraphrases: ["default the timeout to 10s"],
  test_task: "Decide a default timeout.",
  adherence_check: { kind: "judge", expect: "Proposes a 10s default." },
  tension: "default is none",
  surface_markers: ["timeout", "10"],
};

describe("developer-sim", () => {
  it("teaches with a paraphrase, never the canonical string", () => {
    for (let seed = 0; seed < 1; seed += 0.1) {
      const p = pickParaphrase(RULE, seed);
      expect(RULE.paraphrases).toContain(p);
      const prompt = teachPrompt(RULE, p);
      expect(prompt.toLowerCase()).not.toContain(RULE.canonical.toLowerCase());
    }
  });

  it("test prompt restates the rule only for the in-context arm", () => {
    expect(testPrompt(RULE, false)).not.toContain("30 seconds");
    expect(testPrompt(RULE, true)).toContain(RULE.canonical);
  });
});

describe("planTrial arm semantics", () => {
  const opts = { ...DEFAULT_RUN_OPTIONS, trials: 1, testSessions: 2 };

  it("gps: mcp on, memory kept, no inject, approves", () => {
    const steps = planTrial(RULE, "gps", opts);
    const tests = steps.filter((s) => s.phase === "test");
    expect(tests).toHaveLength(2);
    expect(tests.every((s) => s.mcpEnabled && !s.memoryWiped && !s.ruleInjected)).toBe(true);
    expect(steps.find((s) => s.phase === "approve")?.approveInbox).toBe(true);
    // teach prompt never leaks the canonical
    expect(steps[0]!.prompt!.toLowerCase()).not.toContain(RULE.canonical.toLowerCase());
  });

  it("baseline: no mcp, memory wiped before each test, no approve step", () => {
    const steps = planTrial(RULE, "baseline", opts);
    expect(steps.some((s) => s.phase === "approve")).toBe(false);
    const tests = steps.filter((s) => s.phase === "test");
    expect(tests.every((s) => !s.mcpEnabled && s.memoryWiped)).toBe(true);
  });

  it("in-context: ceiling — no teach/approve, rule injected each test", () => {
    const steps = planTrial(RULE, "in-context", opts);
    expect(steps.some((s) => s.phase === "teach" || s.phase === "approve")).toBe(false);
    const tests = steps.filter((s) => s.phase === "test");
    expect(tests.every((s) => s.ruleInjected && s.prompt!.includes(RULE.canonical))).toBe(true);
  });

  it("unapproved: captures but leaves inbox unapproved (the gate)", () => {
    const steps = planTrial(RULE, "unapproved", opts);
    const approve = steps.find((s) => s.phase === "approve");
    expect(approve?.approveInbox).toBe(false);
    expect(approve?.note).toMatch(/inbox/i);
    expect(steps.filter((s) => s.phase === "test").every((s) => s.mcpEnabled)).toBe(true);
  });
});

describe("grader: surface / rediscovery / verdict parsing", () => {
  it("isSurfaced requires all markers present", () => {
    expect(isSurfaced("we should cap backoff around 30s", RULE)).toBe(true);
    expect(isSurfaced("we should cap the backoff", RULE)).toBe(false); // missing "30"
  });

  it("surfaceMarkers falls back to canonical tokens when none given", () => {
    const { surface_markers, ...noMarkers } = RULE;
    void surface_markers;
    expect(surfaceMarkers(noMarkers).length).toBeGreaterThan(0);
  });

  it("detectRediscovery flags the rejected alternative", () => {
    expect(detectRediscovery("I propose no default timeout for now", DECISION)).toBe(true);
    expect(detectRediscovery("I propose a 10s default timeout", DECISION)).toBe(false);
  });

  it("parseVerdict handles JSON and bare keywords", () => {
    expect(parseVerdict('{"verdict":"honored","why":"x"}')).toBe("honored");
    expect(parseVerdict("the change VIOLATED the rule")).toBe("violated");
    expect(parseVerdict("unrelated")).toBe("NA");
  });

  it("judgeAdherence takes the panel majority", async () => {
    const votes = ['{"verdict":"honored"}', '{"verdict":"honored"}', '{"verdict":"violated"}'];
    let i = 0;
    const fake: JudgeFn = async () => votes[i++ % votes.length]!;
    const { honored, votes: raw } = await judgeAdherence(RULE, "diff", { judges: 3, judge: fake });
    expect(honored).toBe(true);
    expect(raw).toEqual(["honored", "honored", "violated"]);
  });

  it("gradeGrep: exit 0 honored, non-zero not", async () => {
    expect(await gradeGrep(process.cwd(), "true")).toBe(true);
    expect(await gradeGrep(process.cwd(), "false")).toBe(false);
  });
});

describe("metrics", () => {
  const mk = (arm: Arm, surfaced: boolean, honored: boolean | null): SessionResult => ({
    arm,
    rule_id: "r",
    trial: 0,
    session_index: 1,
    phase: "test",
    transcript: "",
    context: "",
    duration_sec: 0,
    timed_out: false,
    grade: { surfaced, honored, rediscovered: false, judge_votes: [] },
  });

  it("surface/adherence rates", () => {
    const s = [mk("gps", true, true), mk("gps", true, false), mk("gps", false, null)];
    expect(surfaceRate(s).rate).toBeCloseTo(2 / 3);
    // adherence denominator excludes the null (NA) session
    expect(adherenceRate(s).rate).toBeCloseTo(1 / 2);
  });

  it("leakage is 0 only when unapproved never surfaces/honors", () => {
    expect(leakage([mk("unapproved", false, false)])).toBe(0);
    expect(leakage([mk("unapproved", true, false)])).toBe(1);
    expect(leakage([mk("gps", true, true)])).toBe(0); // other arms don't count
  });

  it("rediscovery rate counts flagged sessions", () => {
    const s: SessionResult[] = [
      { ...mk("baseline", false, null), grade: { surfaced: false, honored: null, rediscovered: true, judge_votes: [] } },
      mk("baseline", false, null),
    ];
    expect(rediscoveryRate(s).rate).toBeCloseTo(1 / 2);
  });

  it("cohenKappa: perfect agreement = 1, and panelKappa averages pairs", () => {
    expect(cohenKappa([true, false, true], [true, false, true])).toBeCloseTo(1);
    const k = panelKappa([
      [true, false, true],
      [true, false, true],
      [true, false, false],
    ]);
    expect(k).toBeLessThanOrEqual(1);
    expect(k).toBeGreaterThan(0);
  });

  it("bootstrapMeanCI is deterministic and brackets the mean", () => {
    const a = bootstrapMeanCI([1, 2, 3, 4, 5]);
    const b = bootstrapMeanCI([1, 2, 3, 4, 5]);
    expect(a).toEqual(b);
    expect(a.mean).toBeCloseTo(3);
    expect(a.lo).toBeLessThanOrEqual(3);
    expect(a.hi).toBeGreaterThanOrEqual(3);
  });
});

describe("reset (real temp git repo, no network)", () => {
  it("resetCodeOnly restores tracked edits + removes stray files but keeps .gps; wipeMemory removes .gps", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "mem-reset-"));
    try {
      await exec("git", ["-C", repo, "init", "-q"]);
      await exec("git", ["-C", repo, "config", "user.email", "t@t"]);
      await exec("git", ["-C", repo, "config", "user.name", "t"]);
      await writeFile(path.join(repo, "src.ts"), "original\n");
      await exec("git", ["-C", repo, "add", "."]);
      await exec("git", ["-C", repo, "commit", "-qm", "init"]);

      // simulate an edit + stray file + persisted memory
      await writeFile(path.join(repo, "src.ts"), "edited\n");
      await writeFile(path.join(repo, "stray.txt"), "junk\n");
      await mkdir(path.join(repo, ".gps"), { recursive: true });
      await writeFile(path.join(repo, ".gps", "memory.json"), "{}");

      await resetCodeOnly(repo);

      const src = await exec("git", ["-C", repo, "show", "HEAD:src.ts"]);
      expect(src.stdout).toBe("original\n");
      await expect(stat(path.join(repo, "stray.txt"))).rejects.toThrow(); // stray removed
      await expect(stat(path.join(repo, ".gps", "memory.json"))).resolves.toBeTruthy(); // memory kept

      await wipeMemory(repo);
      await expect(stat(path.join(repo, ".gps"))).rejects.toThrow(); // now gone
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("resetCodeOnly refuses a non-git dir", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mem-nogit-"));
    try {
      await expect(resetCodeOnly(dir)).rejects.toThrow(/not a git repo/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("rule bank", () => {
  it("ky rules load, validate, and cover all four memory types", async () => {
    const rules = await loadRules(path.join(HERE, "rules", "ky"));
    expect(rules.length).toBeGreaterThanOrEqual(6);
    const types = new Set(rules.map((r) => r.type));
    expect([...types].sort()).toEqual(["decision", "directive", "lesson", "preference"]);
    // no paraphrase leaks the canonical
    for (const r of rules) {
      expect(r.paraphrases.some((p) => p.toLowerCase() === r.canonical.toLowerCase())).toBe(false);
    }
  });

  it("validateRule rejects a decision rule with no rejected alternative", () => {
    expect(() =>
      validateRule(
        { ...DECISION, rejected: undefined } as Partial<Rule>,
        "x.yml",
      ),
    ).toThrow(/rejected/);
  });

  it("validateRule rejects a paraphrase equal to the canonical", () => {
    expect(() =>
      validateRule({ ...RULE, paraphrases: [RULE.canonical] } as Partial<Rule>, "x.yml"),
    ).toThrow(/leak/);
  });

  it("forkky rules load, validate, cover all four types, and carry the rebrand", async () => {
    const rules = await loadRules(path.join(HERE, "rules", "forkky"));
    expect(rules.length).toBeGreaterThanOrEqual(6);
    expect([...new Set(rules.map((r) => r.type))].sort()).toEqual([
      "decision",
      "directive",
      "lesson",
      "preference",
    ]);
    const trace = rules.find((r) => r.id === "trace-header")!;
    expect(trace.canonical).toContain("X-Veki-Trace");
    // no fork rule should mention the original brand "ky"/"Ky" in its task wording
    for (const r of rules) {
      expect(/\bky\b/i.test(r.test_task)).toBe(false);
    }
  });
});

describe("parseAgentJson (E6 token accounting)", () => {
  it("sums tokens across modelUsage and reads cost + turns", () => {
    const json = JSON.stringify({
      result: "the answer",
      total_cost_usd: 0.12,
      num_turns: 4,
      modelUsage: {
        "claude-opus": { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 50 },
        "claude-haiku": { inputTokens: 10, outputTokens: 2 },
      },
    });
    const u = parseAgentJson(json);
    expect(u.out).toBe("the answer");
    expect(u.tokensIn).toBe(100 + 5 + 50 + 10); // 165
    expect(u.tokensOut).toBe(22);
    expect(u.costUsd).toBeCloseTo(0.12);
    expect(u.numTurns).toBe(4);
  });

  it("falls back to raw text with zero usage on non-json", () => {
    const u = parseAgentJson("just plain text");
    expect(u.out).toBe("just plain text");
    expect(u.tokensIn).toBe(0);
    expect(u.tokensOut).toBe(0);
    expect(u.costUsd).toBe(0);
  });
});

describe("seedDistractors (E4)", () => {
  it("merges N decoys into preferences.yml while keeping the real captured rule", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "mem-distract-"));
    try {
      await mkdir(path.join(repo, ".gps"), { recursive: true });
      // an already-captured real preference must survive the merge
      const real = [{ id: "real00000000", text: "cap backoff at 17s", scope: "repo", source: "manual", recorded_at: "2026-01-01T00:00:00Z", hits: 0 }];
      await writeFile(path.join(repo, ".gps", "preferences.yml"), JSON.stringify(real));

      await seedDistractors(repo, 10);

      const prefs = parseYamlTest(await readFile(path.join(repo, ".gps", "preferences.yml"), "utf8")) as Array<{ id: string; topic?: string }>;
      expect(prefs.length).toBe(11); // 1 real + 10 decoys
      expect(prefs.some((p) => p.id === "real00000000")).toBe(true);
      expect(prefs.filter((p) => p.topic === "distractor").length).toBe(10);
      // ids are unique
      expect(new Set(prefs.map((p) => p.id)).size).toBe(prefs.length);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("is a no-op for n <= 0", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "mem-distract0-"));
    try {
      await seedDistractors(repo, 0);
      await expect(stat(path.join(repo, ".gps", "preferences.yml"))).rejects.toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("report aggregation", () => {
  const mk = (
    arm: Arm,
    rule_id: string,
    surfaced: boolean,
    honored: boolean | null,
    extra: Partial<SessionResult> = {},
  ): SessionResult => ({
    arm,
    rule_id,
    trial: 0,
    session_index: 1,
    phase: "test",
    transcript: "",
    context: "",
    duration_sec: 0,
    timed_out: false,
    grade: { surfaced, honored, rediscovered: false, judge_votes: [] },
    ...extra,
  });

  it("fmtPct renders rate, CI and n", () => {
    const s = [mk("gps", "r", true, true), mk("gps", "r", true, true)];
    expect(fmtPct(surfaceRate(s))).toMatch(/100% \(.*n=2\)/);
    expect(fmtPct({ hits: 0, n: 0, rate: 0, ci: { low: 0, high: 0 } })).toMatch(/n=0/);
  });

  it("meanField averages a numeric session field over test sessions", () => {
    const s = [
      mk("gps", "r", true, true, { tokens_in: 100, tokens_out: 50 }),
      mk("gps", "r", true, true, { tokens_in: 200, tokens_out: 100 }),
    ];
    const m = meanField(s, (x) => (x.tokens_in ?? 0) + (x.tokens_out ?? 0));
    expect(m.mean).toBeCloseTo((150 + 300) / 2);
    expect(m.n).toBe(2);
  });

  it("judgeKappa uses fully-judged binary sessions, null when none", () => {
    const judged = (votes: ("honored" | "violated" | "NA")[]): SessionResult =>
      mk("gps", "r", true, true, { grade: { surfaced: true, honored: true, rediscovered: false, judge_votes: votes } });
    const sessions = [
      judged(["honored", "honored", "honored"]),
      judged(["violated", "violated", "violated"]),
    ];
    const k = judgeKappa(sessions, 3);
    expect(k).not.toBeNull();
    expect(k!).toBeCloseTo(1);
    expect(judgeKappa([mk("gps", "r", true, true)], 3)).toBeNull(); // no judge votes
  });

  it("renderReport produces the headline, token and summary sections", () => {
    const sessions = [
      mk("gps", "retry-cap-17s", true, true, { tokens_in: 1000, tokens_out: 100, cost_usd: 0.1, num_turns: 2 }),
      mk("gps", "default-timeout-13s", true, true, { tokens_in: 1100, tokens_out: 120, cost_usd: 0.11, num_turns: 2 }),
      mk("baseline", "retry-cap-17s", false, false, { tokens_in: 1500, tokens_out: 200, cost_usd: 0.2, num_turns: 6 }),
      mk("baseline", "default-timeout-13s", false, false, { tokens_in: 1600, tokens_out: 220, cost_usd: 0.21, num_turns: 7 }),
    ];
    const typeOf = new Map<string, RuleType>([
      ["retry-cap-17s", "preference"],
      ["default-timeout-13s", "decision"],
    ]);
    const md = renderReport({ sessions, typeOf, judges: 3 });
    expect(md).toContain("E1 — Cross-session memory reuse");
    expect(md).toContain("E6 — Token");
    expect(md).toContain("## Summary");
    // gps adherence (100%) should beat baseline (0%): lift shows as 100pp
    expect(renderHeadline(sessions, 3)).toContain("100pp");
    expect(renderTokens(sessions)).toContain("baseline");
  });

  it("flattenSessions flattens trial results", () => {
    const trials: TrialResult[] = [
      { arm: "gps", rule_id: "r", trial: 0, sessions: [mk("gps", "r", true, true)] },
      { arm: "baseline", rule_id: "r", trial: 0, sessions: [mk("baseline", "r", false, false)] },
    ];
    expect(flattenSessions(trials)).toHaveLength(2);
  });
});
