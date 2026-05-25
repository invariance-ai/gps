# Compare-All: self

- Date: 2026-05-12T19:18:51.082Z
- Corpus root: `<repo>/.claude/worktrees/gps-feature-observability`
- Sample size: 10
- Token estimation: chars / 4

## Side-by-side

| tool | tokens (mean) | tokens (p95) | ms p50 | ms p95 | ms mean | recall | callers | callees | tests |
|---|---|---|---|---|---|---|---|---|---|
| gps-brief | 180 (77% vs rg) | 424 | 136 | 202 | 128 | — | — | — | — |
| gps-full | 212 (73% vs rg) | 535 | 135 | 267 | 135 | — | — | — | — |
| rg | 779 (0% vs rg) | 1380 | 12.2 | 15.6 | 12.5 | — | — | — | — |

## Notes

- `gps-brief` is the default mode (budget=1500); `gps-full` matches pre-PR behavior.
- `rg` bundle = `rg --json <symbol>` + `rg -A 5 -B 2 <symbol> | head -50` (what a no-tool agent would actually run).
- Recall is judged by `claude -p` extracting answers from each tool's output, scored against GPS's structural oracle (callers/callees) and GPS's testsForSymbol (tests). GPS's recall ceiling is therefore 1.0 by construction — the interesting numbers are whether rg/cmm can also recover those answers, and at what token cost.
