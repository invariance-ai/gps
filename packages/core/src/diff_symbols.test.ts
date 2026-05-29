import { describe, expect, it } from "vitest";
import type { SymbolRef } from "@invariance/gps-schemas";
import type { GpsIndex } from "./index_store.js";
import { symbolsForDiff } from "./diff_symbols.js";

function symbol(name: string, line: number, endLine: number, file = "src/refunds.ts"): SymbolRef {
  return {
    id: `${file}:${name}:${line}`,
    name,
    qualified_name: name,
    file,
    line,
    end_line: endLine,
    kind: "function",
  };
}

function index(symbols: SymbolRef[]): GpsIndex {
  return {
    version: 2,
    built_at: new Date().toISOString(),
    root: "/repo",
    files: [...new Set(symbols.map((s) => s.file))],
    symbols,
    edges: [],
  };
}

describe("symbolsForDiff", () => {
  it("uses hunk ranges instead of attributing every symbol in a changed file", () => {
    const idx = index([
      symbol("createRefund", 10, 40),
      symbol("refundReport", 80, 120),
    ]);

    const hits = symbolsForDiff(idx, ["src/refunds.ts"], [
      { file: "src/refunds.ts", start_line: 90, end_line: 92 },
    ]);

    expect(hits.map((s) => s.name)).toEqual(["refundReport"]);
  });

  it("falls back to file-wide attribution for files without git hunks", () => {
    const idx = index([
      symbol("createRefund", 10, 40),
      symbol("newHelper", 1, 5, "src/new.ts"),
    ]);

    const hits = symbolsForDiff(idx, ["src/refunds.ts", "src/new.ts"], [
      { file: "src/refunds.ts", start_line: 12, end_line: 13 },
    ]);

    expect(hits.map((s) => s.name)).toEqual(["createRefund", "newHelper"]);
  });

  it("preserves an empty precise result when tracked hunks miss all indexed symbols", () => {
    const idx = index([symbol("createRefund", 10, 40)]);

    const hits = symbolsForDiff(idx, ["src/refunds.ts"], [
      { file: "src/refunds.ts", start_line: 100, end_line: 101 },
    ]);

    expect(hits).toEqual([]);
  });
});
