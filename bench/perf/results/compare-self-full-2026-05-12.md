# Compare-All: self

- Date: 2026-05-12T21:00:24.660Z
- Corpus root: `<repo>/.claude/worktrees/gps-feature-observability`
- Sample size: 5
- Token estimation: chars / 4

## Side-by-side

| tool | tokens (mean) | tokens (p95) | ms p50 | ms p95 | ms mean | recall | callers | callees | tests |
|---|---|---|---|---|---|---|---|---|---|
| gps-brief | 130 (80% vs rg) | 151 | 194 | 200 | 193 | 100% | 100% | 100% | 100% |
| gps-full | 141 (79% vs rg) | 203 | 189 | 369 | 223 | — | — | — | — |
| rg | 663 (0% vs rg) | 937 | 12.5 | 14.2 | 12.7 | 100% | 100% | 100% | 100% |
| codebase-memory-mcp | 349 (47% vs rg) | 1177 | 6.55 | 7.93 | 6.80 | 100% | 100% | 100% | 100% |

## Notes

- `gps-brief` is the default mode (budget=1500); `gps-full` matches pre-PR behavior.
- `rg` bundle = `rg --json <symbol>` + `rg -A 5 -B 2 <symbol> | head -50` (what a no-tool agent would actually run).
- Recall is judged by `claude -p` extracting answers from each tool's output, scored against GPS's structural oracle (callers/callees) and GPS's testsForSymbol (tests). GPS's recall ceiling is therefore 1.0 by construction — the interesting numbers are whether rg/cmm can also recover those answers, and at what token cost.
