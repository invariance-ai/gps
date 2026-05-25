# Compare-All: django

- Date: 2026-05-16T20:15:01.907Z
- Corpus root: `~/.cache/gps-bench/corpora/django`
- Sample size: 8
- Token estimation: chars / 4

## Side-by-side

| tool | tokens (mean) | tokens (p95) | ms p50 | ms p95 | ms mean | recall | callers | callees | tests |
|---|---|---|---|---|---|---|---|---|---|
| gps-brief | 819 (98% vs rg) | 2185 | 153 | 352 | 181 | 85% | 54% | 100% | 100% |
| gps-full | 2487 (93% vs rg) | 8851 | 152 | 346 | 176 | — | — | — | — |
| rg | 34717 (0% vs rg) | 129351 | 282 | 402 | 289 | 56% | 27% | 60% | 80% |
| codebase-memory-mcp | 450 (99% vs rg) | 1265 | 8.97 | 16.7 | 10.2 | 47% | 40% | 60% | 40% |

## Notes

- `gps-brief` is the default mode (budget=1500); `gps-full` matches pre-PR behavior.
- `rg` bundle = `rg --json <symbol>` + `rg -A 5 -B 2 <symbol> | head -50` (what a no-tool agent would actually run).
- Recall is judged by `claude -p` extracting answers from each tool's output, scored against GPS's structural oracle (callers/callees) and GPS's testsForSymbol (tests). GPS's recall ceiling is therefore 1.0 by construction — the interesting numbers are whether rg/cmm can also recover those answers, and at what token cost.
