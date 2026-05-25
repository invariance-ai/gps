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
