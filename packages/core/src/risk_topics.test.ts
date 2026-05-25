import { describe, expect, it } from "vitest";
import { REQUIRE_APPROVAL_FOR, matchedRiskTopics } from "./risk_topics.js";

describe("matchedRiskTopics", () => {
  it("matches a payments lesson", () => {
    expect(matchedRiskTopics("update the payment refund flow")).toEqual(["payments"]);
  });

  it("matches auth keywords", () => {
    expect(matchedRiskTopics("never log the session token")).toContain("auth");
  });

  it("matches multiple topics in one text", () => {
    const hits = matchedRiskTopics("the migration must encrypt PII before backfill");
    expect(hits).toEqual(expect.arrayContaining(["migrations", "security", "compliance"]));
  });

  it("returns empty for benign text", () => {
    expect(matchedRiskTopics("rename the helper and tidy imports")).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(matchedRiskTopics("DROP TABLE users")).toContain("destructive_actions");
  });

  it("preserves canonical topic order", () => {
    const hits = matchedRiskTopics("destructive delete during an auth migration");
    // order follows REQUIRE_APPROVAL_FOR, not match order
    const order = hits.map((t) => REQUIRE_APPROVAL_FOR.indexOf(t));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
