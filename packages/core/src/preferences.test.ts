import { describe, expect, it } from "vitest";
import { extractPreferences } from "./preferences.js";

function texts(prompt: string): string[] {
  return extractPreferences(prompt).map((e) => e.text);
}

describe("extractPreferences — transient instructions are NOT captured", () => {
  it.each([
    "Do not write code yet",
    "You do not need to change code right now",
    "don't bother for now",
    "Don't edit anything yet, just read the files.",
    "For now, do not run the tests.",
    "Stop right now and wait.",
  ])("ignores transient phrasing: %s", (prompt) => {
    expect(extractPreferences(prompt)).toEqual([]);
  });
});

describe("extractPreferences — broadened durability cues (recall)", () => {
  it.each([
    ["we clamp the backoff delay to seventeen seconds, no exceptions", /clamp the backoff/i],
    ["in this repo we deliberately retry POSTs as well, not just the safe methods", /retry posts/i],
    ["decision: POST should be retried by default like the idempotent verbs", /retried by default/i],
    ["the public cancel knob should be called cancelToken in this repo", /cancelToken/i],
    ["our cancellation option is named cancelToken", /cancelToken/i],
    ["we want failed POSTs retried automatically", /retried automatically/i],
    ["thirteen seconds should be the out-of-the-box timeout", /out-of-the-box timeout/i],
    ["we learned to stop throwing on 404", /throwing on 404/i],
    ["from here on, validate inputs at the boundary", /validate inputs/i],
  ])("captures durable phrasing: %s", (prompt, re) => {
    const t = texts(prompt);
    expect(t.length).toBeGreaterThanOrEqual(1);
    expect(t.join(" ")).toMatch(re);
  });
});

describe("extractPreferences — broadened cues keep precision (no transient leakage)", () => {
  it.each([
    "in this repo, find the bug for now",
    "by default it fails right now, just debug it this time",
    "we should look at this together this session",
    "reading the same file again, stop",
    "let's look at this file",
    "now open the config",
    // first-person commentary / questions — conversation, not durable rules
    "I always get confused by this retry logic, can you explain it?",
    "should we always validate inputs here?",
    "I'm always noticing the tests are flaky",
  ])("still ignores transient phrasing: %s", (prompt) => {
    expect(extractPreferences(prompt)).toEqual([]);
  });
});

describe("extractPreferences — durable preferences ARE captured", () => {
  it("captures 'from now on always ...'", () => {
    const t = texts("From now on always cap backoff at 30s");
    expect(t.length).toBe(1);
    expect(t[0]!).toMatch(/cap backoff at 30s/i);
  });

  it("captures 'we never retry POST by default'", () => {
    const t = texts("we never retry POST by default");
    expect(t.length).toBe(1);
    expect(t[0]!).toMatch(/retry POST by default/i);
  });

  it("captures 'I prefer named exports'", () => {
    const t = texts("I prefer named exports");
    expect(t.length).toBe(1);
    expect(t[0]!).toMatch(/named exports/i);
  });

  it("captures 'going forward' rules", () => {
    const t = texts("Going forward, always run pnpm test before pushing");
    expect(t.length).toBe(1);
    expect(t[0]!).toMatch(/run pnpm test before pushing/i);
  });
});

describe("extractPreferences — mixed prompts", () => {
  it("captures the durable rule but drops the transient instruction", () => {
    const prompt =
      "Do not write code yet. From now on always validate inputs at the boundary.";
    const t = texts(prompt);
    expect(t.length).toBe(1);
    expect(t[0]!).toMatch(/validate inputs at the boundary/i);
  });

  it("requires substance (>= 3 content words)", () => {
    expect(extractPreferences("always do it")).toEqual([]);
  });
});
