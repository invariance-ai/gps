import { describe, it, expect } from "vitest";
import type { SymbolRef } from "@invariance/gps-schemas";
import type { GpsIndex } from "./index_store.js";
import { scoreSymbol, searchSymbols } from "./search.js";

function sym(partial: Omit<Partial<SymbolRef>, "tokens"> & { name: string; tokens?: string[] }): SymbolRef {
  return {
    name: partial.name,
    qualified_name: partial.qualified_name ?? partial.name,
    file: partial.file ?? "src/x.ts",
    line: partial.line ?? 1,
    kind: partial.kind ?? "function",
    // Tokens are stored space-joined in the real index; accept an array here
    // for test readability and join it the way the indexer does.
    ...(partial.tokens ? { tokens: partial.tokens.join(" ") } : {}),
  };
}

function indexOf(symbols: SymbolRef[]): GpsIndex {
  return { version: 2, built_at: new Date().toISOString(), root: "/tmp", files: [], symbols, edges: [] };
}

describe("scoreSymbol", () => {
  it("scores name tiers above semantic tiers", () => {
    // Top-level symbol: qualified_name === name, so an exact query hits the
    // qualified tier (100) — still a name-tier match, above any token match.
    const named = scoreSymbol(sym({ name: "retry" }), "retry");
    const semantic = scoreSymbol(sym({ name: "calculateDelay", tokens: ["retry", "backoff"] }), "retry");
    expect(named?.score).toBe(100);
    expect(named?.match_reason).not.toBe("tokens");
    expect(semantic?.match_reason).toBe("tokens");
    expect(semantic!.score).toBeLessThan(named!.score);
  });

  it("matches a symbol whose name omits the query but whose tokens contain it", () => {
    const m = scoreSymbol(sym({ name: "calculateRetryDelay", tokens: ["backoff", "delay", "retry"] }), "backoff");
    expect(m).not.toBeNull();
    expect(m?.match_reason).toBe("tokens");
  });

  it("returns null when neither name nor tokens match", () => {
    expect(scoreSymbol(sym({ name: "foo", tokens: ["bar"] }), "backoff")).toBeNull();
  });

  it("name-only indexes (no tokens) only match on names", () => {
    expect(scoreSymbol(sym({ name: "foo" }), "backoff")).toBeNull();
  });
});

describe("searchSymbols", () => {
  it("ranks the name match ahead of a body-only match", () => {
    const idx = indexOf([
      sym({ name: "calculateDelay", tokens: ["backoff", "delay"] }), // body match only
      sym({ name: "backoff" }), // name match
    ]);
    const results = searchSymbols(idx, "backoff");
    expect(results[0]?.symbol.name).toBe("backoff");
    expect(results[0]?.match_reason).not.toBe("tokens"); // matched on its name, not body
    expect(results[1]?.symbol.name).toBe("calculateDelay");
    expect(results[1]?.match_reason).toBe("tokens");
  });

  it("finds a semantically-relevant symbol when no name matches", () => {
    const idx = indexOf([
      sym({ name: "request" }),
      sym({ name: "calculateRetryDelay", tokens: ["backoff", "retry", "delay"] }),
    ]);
    const results = searchSymbols(idx, "backoff");
    expect(results).toHaveLength(1);
    expect(results[0]?.symbol.name).toBe("calculateRetryDelay");
  });
});
