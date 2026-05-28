import { describe, expect, it } from "vitest";
import type { SymbolRef } from "@invariance/gps-schemas";
import type { GpsIndex } from "./index_store.js";
import { inferSymbolMatches } from "./symbol_infer.js";

function sym(partial: Omit<Partial<SymbolRef>, "tokens"> & { name: string; tokens?: string[] }): SymbolRef {
  return {
    name: partial.name,
    qualified_name: partial.qualified_name ?? partial.name,
    file: partial.file ?? "src/x.ts",
    line: partial.line ?? 1,
    kind: partial.kind ?? "function",
    ...(partial.tokens ? { tokens: partial.tokens.join(" ") } : {}),
  };
}

function indexOf(symbols: SymbolRef[]): GpsIndex {
  return { version: 2, built_at: new Date().toISOString(), root: "/tmp", files: [], symbols, edges: [] };
}

describe("inferSymbolMatches — snake_case / leading-underscore names (the Python gap)", () => {
  it("resolves a snake_case symbol named verbatim in the intent (high confidence)", () => {
    const idx = indexOf([
      sym({ name: "_compute_loss", file: "training/base/trainer.py", line: 175 }),
      sym({ name: "compute_gae", file: "training/ppo/trainer.py", line: 293 }),
    ]);
    const matches = inferSymbolMatches(idx, "fix the math in _compute_loss");
    expect(matches[0]?.symbol.name).toBe("_compute_loss");
    // Exact name match — not a low-confidence fuzzy guess.
    expect(matches[0]?.score).toBeGreaterThanOrEqual(95);
    expect(matches[0]?.via).not.toBe("fuzzy");
  });

  it("resolves a plain snake_case symbol from the intent", () => {
    const idx = indexOf([sym({ name: "run_training", file: "backend/main.py" })]);
    const matches = inferSymbolMatches(idx, "change how run_training starts the loop");
    expect(matches.map((m) => m.symbol.name)).toContain("run_training");
  });

  it("regression: the old name-tier extractor missed leading-underscore names entirely", () => {
    // Before snake_case extraction, "_compute_loss" produced zero candidates and
    // prepare/plan hard-errored. Guard that it now resolves.
    const idx = indexOf([sym({ name: "_compute_loss" })]);
    expect(inferSymbolMatches(idx, "_compute_loss").length).toBeGreaterThan(0);
  });
});

describe("inferSymbolMatches — fuzzy fallback for natural-language intent", () => {
  it("falls back to token search when no name tier matches (and caps confidence)", () => {
    const idx = indexOf([
      sym({ name: "compute_gae", tokens: ["compute", "advantage", "gae", "generalized"] }),
      sym({ name: "unrelated", tokens: ["http", "server"] }),
    ]);
    // No symbol is *named* in this phrase; resolution must come from tokens.
    const matches = inferSymbolMatches(idx, "change how the advantage is computed");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.symbol.name).toBe("compute_gae");
    expect(matches[0]?.via).toBe("fuzzy");
    // A fuzzy guess must never claim the high confidence reserved for name matches.
    expect(matches[0]?.score).toBeLessThanOrEqual(60);
  });

  it("resolves an ALL-CAPS acronym via tokens even when the name tier drops it", () => {
    const idx = indexOf([sym({ name: "PPOTrainer", tokens: ["ppo", "trainer", "policy"] })]);
    const matches = inferSymbolMatches(idx, "tweak the PPO trainer setup");
    expect(matches.map((m) => m.symbol.name)).toContain("PPOTrainer");
  });

  it("returns nothing when neither names nor tokens overlap the intent", () => {
    const idx = indexOf([sym({ name: "alpha", tokens: ["beta", "gamma"] })]);
    expect(inferSymbolMatches(idx, "completely unrelated phrasing here")).toEqual([]);
  });
});
