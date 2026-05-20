# Compare-All: flask

- Date: 2026-05-16T20:11:35.425Z
- Corpus root: `/Users/hardiksingh/.cache/gps-bench/corpora/flask`
- Sample size: 10
- Token estimation: chars / 4

## Side-by-side

| tool | tokens (mean) | tokens (p95) | ms p50 | ms p95 | ms mean | recall | callers | callees | tests |
|---|---|---|---|---|---|---|---|---|---|
| gps-brief | 190 (80% vs rg) | 468 | 320 | 817 | 384 | 100% | 100% | 100% | 100% |
| gps-full | 248 (74% vs rg) | 701 | 397 | 816 | 460 | — | — | — | — |
| rg | 962 (0% vs rg) | 4732 | 44.4 | 95.1 | 50.1 | 100% | 100% | 100% | 100% |
| codebase-memory-mcp | 178 (82% vs rg) | 601 | 19.0 | 26.2 | 19.3 | 73% | 80% | 100% | 40% |

## Notes

- `gps-brief` is the default mode (budget=1500); `gps-full` matches pre-PR behavior.
- `rg` bundle = `rg --json <symbol>` + `rg -A 5 -B 2 <symbol> | head -50` (what a no-tool agent would actually run).
- Recall is judged by `claude -p` extracting answers from each tool's output, scored against GPS's structural oracle (callers/callees) and GPS's testsForSymbol (tests). GPS's recall ceiling is therefore 1.0 by construction — the interesting numbers are whether rg/cmm can also recover those answers, and at what token cost.
