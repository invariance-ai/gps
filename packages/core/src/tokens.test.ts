import { describe, it, expect } from "vitest";
import { extractTokens, splitIdentifier } from "./tokens.js";

describe("splitIdentifier", () => {
  it("splits camelCase", () => {
    expect(splitIdentifier("backoffLimit")).toEqual(["backoff", "limit"]);
  });
  it("splits ACRONYMCase", () => {
    expect(splitIdentifier("HTTPError")).toEqual(["http", "error"]);
  });
  it("splits snake_case and kebab", () => {
    expect(splitIdentifier("retry_count")).toEqual(["retry", "count"]);
    expect(splitIdentifier("max-delay")).toEqual(["max", "delay"]);
  });
  it("lowercases a plain word", () => {
    expect(splitIdentifier("Refund")).toEqual(["refund"]);
  });
});

describe("extractTokens", () => {
  it("pulls split identifiers and comment words from a source slice", () => {
    const src = [
      "// compute exponential backoff before the next retry",
      "function calculateRetryDelay(attempt) {",
      "  const backoffMs = baseDelay * 2 ** attempt;",
      "  return Math.min(backoffMs, maxBackoff);",
      "}",
    ].join("\n");
    const toks = extractTokens(src);
    expect(toks).toContain("backoff");
    expect(toks).toContain("retry");
    expect(toks).toContain("delay");
    expect(toks).toContain("attempt");
  });

  it("drops stopwords and tokens of length <= 2", () => {
    const toks = extractTokens("const x = this.value; return new Foo();");
    expect(toks).not.toContain("const");
    expect(toks).not.toContain("this");
    expect(toks).not.toContain("value"); // stopword
    expect(toks).not.toContain("x");
    expect(toks).toContain("foo");
  });

  it("dedupes and honors the cap", () => {
    const toks = extractTokens("alpha alpha alpha beta", 1);
    expect(toks).toHaveLength(1);
  });
});
