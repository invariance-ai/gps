# Pre-registration — gps cross-session memory benchmark

Committed **before** any live run so results cannot be retrofit. Headline is **memory + answer
quality**, never token savings (the 2026-05-12 dogfood showed tokens are ~flat once the agent's
own exploration is counted). Do **not** publish the discredited +33pp prompt-biased figure.

## Hypothesis
A correction taught once in session S1 is reused by a **fresh** session (S2…Sk) with zero carried
context — and only the `gps` arm (persisted, approved memory) achieves this. Baseline cannot
remember; `in-context` is the ceiling; `unapproved` must behave like baseline (the gate works).

## Arms (the only variable is persistence/injection)
| Arm | `.mcp.json` | memory between sessions | rule injected into test prompt | inbox approved |
|---|---|---|---|---|
| `gps` | yes | persisted | no | yes |
| `baseline` | no | wiped before each test | no | n/a |
| `in-context` (ceiling) | no | n/a | yes | n/a |
| `unapproved` (neg. control) | yes | persisted (inbox only) | no | **no** |

## Metrics (formulas frozen here)
- **Surface %** = test sessions where every `surface_marker` of the taught rule appears in the
  agent's gps context / test sessions. (`metrics.surfaceRate`)
- **Adherence %** = test sessions (where adherence applies) whose plan/diff complies with the rule
  / those sessions. Deterministic `grep` check when available, else a **3-judge blind panel**
  (majority of honored/violated; ties → abstain + manual adjudication). (`metrics.adherenceRate`)
- **Rediscovery rate** (B2, decision rules) = test sessions that re-propose the rejected
  alternative / test sessions. (`metrics.rediscoveryRate`)
- **Leakage** (B5 negative control) = `unapproved`-arm test sessions that surfaced or honored the
  rule. **Pre-registered threshold: 0.** (`metrics.leakage`)
- **Inter-judge agreement** = mean pairwise Cohen's κ across the panel, reported alongside every
  judged metric. (`metrics.panelKappa`)
- Proportions report 95% Wilson CIs (gps-core `wilson`); means report 95% bootstrap CIs
  (`metrics.bootstrapMeanCI`, deterministic seed).

## Design (frozen)
- **n ≥ 3 trials** per (rule, arm); **k = 2** test sessions per trial (configurable up).
- Repos: **ky** (`sindresorhus/ky`) first; a small Python lib + an obscure/renamed fork added
  before headline numbers (defeats training-data contamination).
- Rule bank: `bench/memory/rules/<repo>/*.yml`, all four memory types, ≥2 rules per repo in
  tension with the code default. The developer-sim teaches with a **paraphrase**, never the
  canonical string (enforced by `validateRule`); the test task never restates the rule.
- Judge is blind to arm; deterministic checks dominate the headline.

## Pass thresholds (pre-registered)
- `gps` Adherence% − `baseline` Adherence% ≥ **+30pp**, non-overlapping 95% CIs.
- `gps` Surface% ≥ **0.8**.
- `unapproved` Leakage = **0**.
- `gps` Adherence% within **10pp** of `in-context` (approaches the ceiling without being told).

## Threats / mitigations
Training contamination → obscure/renamed fork + synthetic rules + no-teach control subtracted.
Judge noise → 3-judge blind panel + κ reported + deterministic checks dominate. Small n →
≥3×≥3×all-rules, publish every trial incl. failures. Paraphrase leakage → paraphrase ≠ canonical
(validated), test task never restates. Prompt unfairness → identical prompts, only the arm setup
differs. Token overclaim → report honestly, caveat any apparent win.

## Caveat to resolve before the real run
The ky `adherence_check`s currently use `kind: judge` with literal criteria. Pin each rule's
`grep` check and `symbol` to ky's **actual** internals at a fixed SHA (so deterministic checks can
dominate the headline) before publishing numbers.
