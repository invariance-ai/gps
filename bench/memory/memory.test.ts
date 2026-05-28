import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

import { planTrial, loadRules, validateRule } from "./run.js";
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
import { DEFAULT_RUN_OPTIONS, type Rule, type SessionResult, type Arm } from "./types.js";

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
});
