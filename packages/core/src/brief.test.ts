import { describe, it, expect } from "vitest";
import { formatBriefMarkdown, type BriefResult } from "./brief.js";

function baseResult(overrides: Partial<BriefResult> = {}): BriefResult {
  return {
    base: "HEAD",
    changed_files: [],
    changed_symbols: [],
    invariants: { hits: [], blocking_count: 0 },
    notes: [],
    per_symbol: [],
    untested_symbols: [],
    truncated: false,
    source_changes: false,
    ...overrides,
  };
}

describe("formatBriefMarkdown: no-source-change branch", () => {
  it("prints an explicit single-line status when files changed but no source symbols did", () => {
    const r = baseResult({
      changed_files: [".gps/index.json", "docs/README.md"],
      changed_symbols: [],
      source_changes: false,
    });
    const out = formatBriefMarkdown(r);
    expect(out).toContain("No source-file changes detected");
    expect(out).toContain("nothing to check");
    expect(out).toContain("2 file(s) changed");
    // Must NOT dump the empty section headers that read like a clean pass.
    expect(out).not.toContain("## Invariants");
    expect(out).not.toContain("## Notes");
    expect(out).not.toContain("## Tests");
    expect(out).not.toContain("## Changed symbols");
  });

  it("preserves the full markdown report when there ARE source changes", () => {
    const r = baseResult({
      changed_files: ["src/a.ts"],
      changed_symbols: [
        {
          id: "src/a.ts#foo:1",
          name: "foo",
          qualified_name: "foo",
          file: "src/a.ts",
          line: 1,
          end_line: 5,
          kind: "function",
        },
      ],
      per_symbol: [
        {
          symbol: {
            id: "src/a.ts#foo:1",
            name: "foo",
            qualified_name: "foo",
            file: "src/a.ts",
            line: 1,
            end_line: 5,
            kind: "function",
          },
          tests: [],
          questions: [],
        },
      ],
      untested_symbols: ["foo"],
      source_changes: true,
    });
    const out = formatBriefMarkdown(r);
    expect(out).toContain("# Brief — 1 symbol(s) across 1 file(s)");
    expect(out).toContain("## Changed symbols");
    expect(out).toContain("## Invariants");
    expect(out).toContain("## Tests");
    expect(out).not.toContain("No source-file changes detected");
  });
});
