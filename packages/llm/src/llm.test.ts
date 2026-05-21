import { describe, expect, it } from "vitest";
import { GpsLlm } from "./client.js";
import { extractDecisions } from "./attach.js";

describe("GpsLlm dry-run", () => {
  it("returns the rendered prompt without an API key", async () => {
    const llm = new GpsLlm({ dryRun: true });
    const res = await llm.complete({ system: "sys", user: "usr" });
    expect(res.text).toBe("[dry-run]");
    expect(res.dry_run_prompt).toEqual({ system: "sys", user: "usr" });
  });

  it("throws a helpful error when a live call has no key", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => new GpsLlm({ dryRun: false })).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe("extractDecisions dry-run", () => {
  it("surfaces the distillation prompt and persists nothing", async () => {
    const llm = new GpsLlm({ dryRun: true });
    const res = await extractDecisions(llm, {
      transcript: "we chose to validate before conversion (rejected: after, breaks JPY)",
      session_id: "PR-1",
    });
    expect(res.decisions).toEqual([]);
    expect(res.questions).toEqual([]);
    expect(res.dry_run_prompt?.system).toMatch(/decisions/i);
    expect(res.dry_run_prompt?.user).toContain("PR-1");
  });
});
