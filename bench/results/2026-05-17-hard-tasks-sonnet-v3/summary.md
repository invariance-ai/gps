# repo-edit-bench summary

3 task(s) × 3 attempt(s) × 2 arm(s) × 1 agent(s) [sonnet].

## Per agent × arm

| agent | arm | pass rate (95% CI) | mean duration (s) | mean output (chars) | timed out |
|---|---|---|---|---|---|
| sonnet | baseline | 77.8% [45, 94] | 46.6 | 451 | 0 |
| sonnet | gps | 77.8% [45, 94] | 39.6 | 372 | 0 |

## Per agent × task (baseline → gps)

| agent | 004-hidden-caller | 005-invariant-respect | 006-cross-file-extract |
|---|---|---|---|
| sonnet | 100.0%→100.0% (0pp) | 33.3%→33.3% (0pp) | 100.0%→100.0% (0pp) |

## Per task (aggregate across agents)

| task | baseline | gps | delta |
|---|---|---|---|
| 004-hidden-caller | 100.0% | 100.0% | 0.0pp |
| 005-invariant-respect | 33.3% | 33.3% | 0.0pp |
| 006-cross-file-extract | 100.0% | 100.0% | 0.0pp |

## Aggregate (all agents)

| arm | pass rate (95% CI) | mean duration (s) | mean output (chars) | timed out |
|---|---|---|---|---|
| baseline | 77.8% [45, 94] | 46.6 | 451 | 0 |
| gps      | 77.8% [45, 94] | 39.6 | 372 | 0 |
