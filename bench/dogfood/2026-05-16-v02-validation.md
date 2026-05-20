# v0.2 empirical validation — 2026-05-16

Re-runs of every measurable claim in PRs #22, #24, #25, #26, #27, #28 on current HEAD (`b20e5a2`).

## TL;DR (numbers, not adjectives)

| Claim | Old number | New number | Verdict |
|---|---|---|---|
| verify-index precision | 92% @ n=50 | **92.8% @ n=200, CI [88.3, 95.7]** | holds, with tighter CI |
| verify-index recall (new) | — | 79.0% @ n=200, CI [72.8, 84.1] | new baseline |
| verify-index coverage (new) | — | 43.9% | new baseline |
| gps-brief vs rg tokens (self) | 23% cheaper | **12% cheaper** (129 vs 1080) | held |
| gps-brief vs rg tokens (flask) | — | **20% cheaper** (190 vs 962), recall tied at 100% | new |
| gps-brief vs rg tokens (django) | — | **97.6% cheaper** (819 vs 34,717), +29pp recall | new — GPS's strongest result |
| repo-edit-bench (claude -p, n=3) | — | **baseline 66.7% / gps 100%**, Δ +33pp | new — GPS helped |

## 1. verify-index (PR #24 — fix changed sampling methodology)

Self corpus, `--sample 200`, `GPS_VERIFY_SEED=42`:

| metric | value | 95% CI |
|---|---:|---|
| precision | 0.928 | [0.883, 0.957] |
| recall | 0.790 | [0.728, 0.841] |
| coverage | 0.439 | — |
| confirmed / contradicted / inconclusive | 180 / 14 / 6 | — |

Flask + django are Python — verify-index needs tsserver, so it returned `sample_size=0` (TS-only). Not a regression; out-of-scope. To extend, port to pyright.

## 2. bench:compare (GPS vs rg vs cmm)

n=10 self, n=10 flask, n=8 django. Token estimation: chars/4.

| corpus | tool | tokens (mean) | tokens (p95) | ms p50 | recall |
|---|---|---:|---:|---:|---:|
| self | gps-brief | 129 (88% vs rg) | 286 | 562 | — (no judge) |
| self | rg | 1080 | 3120 | 61 | — |
| flask | gps-brief | 190 (80% vs rg) | 468 | 320 | **100%** |
| flask | rg | 962 | 4732 | 44 | **100%** |
| flask | cmm | 178 (82% vs rg) | 601 | 19 | 73% |
| django | gps-brief | 819 (98% vs rg) | 2185 | 153 | **85%** |
| django | rg | 34,717 | 129,351 | 282 | 56% |
| django | cmm | 450 (99% vs rg) | 1265 | 9 | 47% |

**Headline:** on django, rg blows up to 34k tokens with only 56% recall (callers 27%). GPS stays at 819 tok / 85% recall (callers 54%). On flask, both tools tie on recall and GPS is just cheaper.

**Latency caveat:** GPS's p50 jumped from 136ms (2026-05-12) to 562ms (today) on self. Tree-sitter parser (PR #22) is heavier than the regex parser. Still sub-second, still ~12× slower than rg.

## 3. repo-edit-bench (PR #28 — claude -p as the agent)

3 tasks (refund-cap, add-test-coverage, rename-symbol), n=3 attempts/arm, timeout 300s. Fixture committed to `examples/multi-symbol/src/refunds.ts` (see `b20e5a2`).

| arm | pass rate | mean duration (s) | mean output (chars) |
|---|---:|---:|---:|
| baseline | 66.7% | 20.5 | 278 |
| gps | 100.0% | 30.5 | 401 |

| task | baseline | gps | delta |
|---|---:|---:|---:|
| 001-refund-cap | 100% | 100% | 0pp |
| 002-add-test-coverage | **0%** | **100%** | **+100pp** |
| 003-rename-symbol | 100% | 100% | 0pp |

**Honest hole:** the delta on 002 is partly a *prompting* artifact. The gps arm appends "use the gps MCP server (get_context, impact_of, tests_for, invariants_for) before editing." to the prompt. Baseline got the bare prompt and three times produced a chatty answer (156 chars avg) instead of an edit. So the +100pp isn't purely "GPS's tools helped" — it's also "telling claude there are tools available made it act." That said, the gps arm is what a user gets after `gps install claude` wires the system prompt, so it's the right thing to measure for product claims.

**Other holes:** n=3 × 3 tasks = 9 trials per arm — variance is large. Only one agent (claude -p, opus 4.7). Tasks are toy fixtures, not real repo patches. Don't generalize beyond "the harness runs end-to-end and produces non-degenerate numbers."

## 4. PR #25, #26, #27 smokes (non-numeric)

- `gps validate-knowledge` (PR #27): exit 0, found 1 dead anchor on the seeded invariant. Stable-ID matching + Levenshtein working.
- `gps prepare <sym> --intent <text>` (PR #26): renders brief with risk, callers, tests, recent commits. Low-confidence path (intent-only, no symbol) errors cleanly with `gps plan` hint when no match.
- `gps gate --watch --changed` (PR #25): starts watcher, prints "watching … (Ctrl-C to stop)", exits clean on signal. `gps gate --diff --changed` with no diff: "no changed files; nothing to gate", exit 0.

## 5. Not re-run

- Dogfood +11% quality (Sonnet judge over 10 prompts). PR #22's tree-sitter change *could* shift what `gps context` injects, but Steps 1–3 showed no regression in GPS's token cost or recall, so the dogfood number is not invalidated. Re-run deferred (cost ~$30, external repo).

## Repro

```
# bench:compare
pnpm bench:compare:self
pnpm bench:compare -- --corpus flask
pnpm bench:compare -- --corpus django -n 8

# verify-index (TS only)
GPS_VERIFY_SEED=42 gps verify-index --sample 200 --json

# repo-edit-bench
gps bench run --n 3 --timeout 300 --out bench/results/<stamp>
```

All raw outputs under `bench/perf/results/compare-{self,flask,django}-2026-05-16.md` and `bench/results/2026-05-16-baseline-vs-gps/`.

## Addendum: prompt fairness re-run (2026-05-16)

Closes the prompt-artifact hole flagged in section 3. Change (commit on `fix/v0.2-bench-prompt-fairness`): the gps arm no longer appends `"Use the gps MCP server (get_context, impact_of, tests_for, invariants_for) before editing."` to the prompt. Both arms now receive the byte-identical task prompt; the only between-arm difference is whether `.mcp.json` (pointing at `gps serve`) is present in the workdir for `claude -p` to discover via the standard MCP mechanism. `resetWorkingTree` was extended to scrub `.mcp.json` between attempts so the gps config cannot leak to the baseline arm.

Re-run: n=3, timeout=300s, same fixture (`examples/multi-symbol`), same agent (`claude -p`, opus 4.7), same tasks.

| arm | pass rate | mean duration (s) | mean output (chars) | timed out |
|---|---:|---:|---:|---:|
| baseline | 100.0% | 30.5 | 313 | 0 |
| gps      | 100.0% | 35.3 | 273 | 0 |

| task | baseline | gps | delta (old → new) |
|---|---:|---:|---:|
| 001-refund-cap | 100% | 100% | 0pp → 0pp |
| 002-add-test-coverage | **100%** | 100% | **+100pp → 0pp** |
| 003-rename-symbol | 100% | 100% | 0pp → 0pp |

**Honest read.** The +33pp aggregate and +100pp on task 002 from the original run were a *prompting* artifact, not a GPS-tools win. Once both arms get the same prompt and GPS is offered only as a discoverable MCP server, claude -p solves all three toy tasks unaided on this fixture. The harness still works end-to-end; this run just doesn't surface a GPS-vs-baseline signal at n=3 on toy tasks. To find a real signal you'd need (a) harder tasks where GPS's context actually matters (multi-file refactors with hidden callers, invariants under test) or (b) a weaker agent than opus 4.7 that benefits more from injected context. Don't ship the +33pp number — it was prompt-bias.

Raw per-attempt JSON: `bench/results/2026-05-16-prompt-fairness/`.
