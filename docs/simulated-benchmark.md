# repo-edit-bench: Simulated Benchmark Report

> **⚠️ Superseded.** This document captures pre-dogfood simulated estimates of token savings. The measured 2026-05-12 dogfood against invariance-platform ([`bench/dogfood/2026-05-12-invariance-platform.md`](../bench/dogfood/2026-05-12-invariance-platform.md)) showed input tokens were roughly flat (+1.4%) once `claude -p`'s own exploration was accounted for. The token-savings figures below did not survive contact with a real `claude -p` harness — the measured win is **answer quality (+11% overall, 13/19 judge wins)**, not token volume. Keeping this file as a historical record of the pre-measurement design.

**Status:** simulation, not measurement. Numbers are reasoned estimates with stated assumptions.

**Headline (simulated — superseded, see note above):** gps ≈ **62% fewer exploration tokens** and **48% fewer regressions** vs grep-only baseline across 30 tasks. Vector-RAG closes some of the token gap but trails on regressions.

---

## Part 1: Benchmark design

### Repos (3, ~10 tasks each)

| Repo | Stack | LOC | Shape | Why representative |
|---|---|---|---|---|
| `refund-app` | TS / Node / Postgres | ~8k | REST API + workers, Stripe integration | hidden callers, $-invariants, replay paths |
| `etl-pinedrop` | Python / Airflow / DuckDB | ~5k | DAG of transforms, schema-coupled | column-level impact, dtype invariants |
| `orders-svc` | Go / gRPC / Redis | ~6k | service with proto-generated code | interface ripple, generated-code traps |

### Task categories (10 per repo, 30 total)

| # | Category | Hidden complexity | Example |
|---|---|---|---|
| C1 | **Caller ripple** (8) | symbol used in N>1 files incl. non-obvious one | "rename `createRefund` arg `amount` → `amount_cents`" |
| C2 | **Test coupling** (6) | test file uses fixtures/mocks that must update | "add idempotency key to refund create" |
| C3 | **Invariant-guarded edit** (6) | business rule must be preserved | "let CSMs auto-approve refunds < $500" (must keep >$1000 finance rule) |
| C4 | **Schema/contract** (5) | DB column or proto field touched | "add `currency` to orders table" |
| C5 | **Dead-code trap** (3) | code looks unused but is called via reflection/string dispatch | "remove `legacy_export_v1`" |
| C6 | **Cross-language** (2) | TS calls Python via subprocess, Go reads TS-emitted JSON | "change date format in invoice payload" |

### Tool sets

| Set | Tools available |
|---|---|
| `grep-only` | `read`, `grep`, `edit`, `bash` (Claude Code default) |
| `vector-rag` | grep-only + chunk retrieval (top-k=5, ~500 tok/chunk, Aider/Continue-style) |
| `gps` | grep-only + `get_context`, `impact_of`, `tests_for`, `invariants_for` over MCP |

(Baseline `read/grep/edit only` = `grep-only` minus bash; included as a floor in C5/C6 only because most agents in practice have bash.)

### Success criteria per task

1. **Functional check** — script-defined assertion passes (`grep -q`, `pnpm test X`, etc.)
2. **No regression** — full test suite still green
3. **Invariant preserved** — invariants_expected still hold (checked via property assertion or static check)
4. **No spurious files** — only declared-relevant files modified ± 1

### Metrics

| Metric | How measured |
|---|---|
| Success rate | `functional ∧ no_regression ∧ invariant_preserved` |
| Exploration tokens | tokens used before first `edit` tool call |
| Total tokens | full transcript |
| Regression rate | broken pre-existing tests / total runs |
| Tests run | `# test invocations` |
| Wrong-file edits | files touched not in ground-truth set |

---

## Part 2: Simulated results

### Token economics (assumed)

| Source | Tokens |
|---|---|
| Agent's repo exploration loop (grep-only median) | 12k (range 5–30k) |
| One file read (mid-size) | 800–2000 |
| One grep result page | 200–600 |
| Vector RAG: 5 chunks × 500 tok | 2.5k |
| `gps get_context` payload | 600 |
| `gps impact_of` payload | 400 |
| `gps tests_for` payload | 300 |
| `gps invariants_for` payload | 250 |
| gps full 4-call bundle | **~1.55k** |

### Success-rate priors (assumed, per-call)

| Category | grep-only finds it | vector-rag finds it | gps surfaces it |
|---|---|---|---|
| Obvious local edit | 0.90 | 0.92 | 0.95 |
| Non-obvious caller | 0.45 | 0.65 | 0.92 |
| Right test to update | 0.55 | 0.60 | 0.90 |
| Business invariant | 0.20 | 0.25 | 0.85 |
| Reflection/string-dispatch call site | 0.15 | 0.35 | 0.70 |

Rationale: gps's tree-sitter graph wins on caller and test recall because it indexes by symbol not by lexical proximity. Vector RAG beats grep on synonyms but doesn't know what a "caller" is. Invariants only gps has (file-backed `.gps/invariants.yml`). Reflection cases hurt everyone; gps helps partially via call-string heuristics.

### Per-category simulated results

Success% / exploration-tokens / regression%, n = task count.

#### C1 Caller ripple (n=8)

| Tool | Success | Explore tok | Regressions |
|---|---|---|---|
| grep-only | 50% (4/8) | 14.2k | 38% |
| vector-rag | 62% (5/8) | 6.1k | 25% |
| **gps** | **88% (7/8)** | **2.0k** | **12%** |

gps wins via `impact_of`: rev-deps are 1 call vs N greps. The 1 miss is the reflection caller in C5 also bleeding into C1.

#### C2 Test coupling (n=6)

| Tool | Success | Explore tok | Regressions |
|---|---|---|---|
| grep-only | 50% | 9.8k | 33% |
| vector-rag | 50% | 4.5k | 33% |
| **gps** | **83%** | **1.6k** | **17%** |

`tests_for` directly returns covering tests by symbol-in-test-body + file-proximity heuristic. Vector RAG often retrieves test *prose* not the right test.

#### C3 Invariant-guarded (n=6)

| Tool | Success | Explore tok | Regressions |
|---|---|---|---|
| grep-only | 33% | 11.0k | 50% |
| vector-rag | 33% | 5.0k | 50% |
| **gps** | **83%** | **1.9k** | **17%** |

This is gps's strongest category. No competitor exposes the YAML rule. **Caveat:** the win depends on `.gps/invariants.yml` actually being populated — if maintainers don't write invariants, gps degrades to ~C1 numbers here.

#### C4 Schema/contract (n=5)

| Tool | Success | Explore tok | Regressions |
|---|---|---|---|
| grep-only | 60% | 10.5k | 40% |
| vector-rag | 60% | 4.8k | 40% |
| **gps** | **80%** | **2.4k** | **20%** |

Tighter win. Schema callers are usually grep-discoverable (column names are unique strings). gps's edge is `tests_for` catching migration tests.

#### C5 Dead-code trap (n=3)

| Tool | Success | Explore tok | Regressions |
|---|---|---|---|
| grep-only | 0% | 8.0k | 100% (deleted live code) |
| vector-rag | 33% | 4.0k | 67% |
| **gps** | **67%** | **2.2k** | **33%** |

gps's call-graph misses true reflection. Honest partial win. Would need a `dynamic_refs` strand to close this.

#### C6 Cross-language (n=2)

| Tool | Success | Explore tok | Regressions |
|---|---|---|---|
| grep-only | 50% | 15k | 50% |
| vector-rag | 50% | 7k | 50% |
| **gps** | **50%** | **3.5k** | **50%** |

**No advantage.** gps v1 indexes per-language, doesn't link Python ↔ TS via subprocess strings. Flagging this as a known limitation, not hiding it.

### Aggregate (30 tasks)

| Tool | Success | Avg explore tok | Total tok | Regression rate | Tests run/task |
|---|---|---|---|---|---|
| grep-only | 47% (14/30) | 11.4k | 18.2k | 47% | 0.8 |
| vector-rag | 53% (16/30) | 5.2k | 11.0k | 38% | 1.1 |
| **gps** | **80% (24/30)** | **2.1k** | **7.4k** | **22%** | 2.4 |

### Headline numbers (simulated)

- **gps vs grep-only:** -82% exploration tokens, -59% total tokens, -53% regression rate, +70% success
- **gps vs vector-rag:** -60% exploration tokens, -33% total tokens, -42% regression rate, +51% success

Conservative headline (averaging across categories, weighted by n):

> **~62% fewer exploration tokens and ~48% fewer regressions vs grep-only.** The success-rate lift (~70%) assumes invariants are populated; without invariants the lift drops to ~40%.

### What is assumed vs measured

| Assumed | Would be measured |
|---|---|
| Per-call recall priors above | Per-task ground-truth check execution |
| Token costs per call | Real transcript token counts |
| Agent uses gps tools when available | Tool-use rate in transcripts |
| Invariants exist & are correct | Maintainer-curated invariants.yml coverage |
| Equal prompt across tools | Identical system prompt template per run |

### Where gps does **not** clearly win

1. **C6 cross-language** — tied. Needs cross-runtime strand.
2. **C5 reflection** — partial. ~33% regressions remain.
3. **Trivially local edits** — overhead of MCP call sometimes exceeds savings on <50-LOC tasks. Net neutral.
4. **Cold-index cost** — first `gps init` is ~30s on 10k LOC; not in token budget but in wall-clock.

---

## Part 3: Harness spec

### File structure

```
bench/repo-edit-bench/
  tasks/
    001-refund-cap.yml
    002-refund-rename-amount.yml
    ...
    030-orders-currency.yml
  repos/
    refund-app/         # frozen git snapshot
    etl-pinedrop/
    orders-svc/
  runners/
    grep_only.ts        # baseline agent loop
    vector_rag.ts       # chunk-retrieval agent
    gps_agent.ts        # gps-MCP-enabled agent
  scoring/
    score.ts            # functional + regression + invariant checks
    aggregate.ts        # per-tool, per-category rollup
  results/
    2026-05-11/
      grep-only.jsonl
      vector-rag.jsonl
      gps.jsonl
      report.md
```

### Task YAML

```yaml
id: 002-refund-rename-amount
repo: refund-app
category: C1
prompt: |
  Rename the `amount` parameter of createRefund to `amount_cents`
  throughout the codebase. All callers and tests must still pass.
ground_truth:
  files_expected:
    - apps/api/src/refunds.ts
    - apps/api/src/workers/supportRefundWorkflow.ts
    - apps/api/src/replay/replayRefundCase.ts
    - apps/api/test/refund-approval.test.ts
  invariants_expected:
    - "High-value refunds require approval"
checks:
  functional:
    - "! grep -rn 'amount[^_]' apps/api/src/refunds.ts"
    - "pnpm -C apps/api test refund"
  regression:
    - "pnpm -C apps/api test"
  invariant:
    - "node scripts/check-finance-approval.js"
budget:
  max_tokens: 50000
  max_wall_seconds: 300
```

### Run loop

```
for tool in [grep-only, vector-rag, gps]:
  for task in tasks/*.yml:
    snapshot = git_clone(task.repo)
    transcript = run_agent(tool, task.prompt, snapshot, budget=task.budget)
    score = score(snapshot, task.ground_truth, task.checks)
    write(results/<date>/<tool>.jsonl, {task, transcript, score})
aggregate(results/<date>/) -> report.md
```

### Score aggregation

```
success_rate = mean(functional ∧ no_regression ∧ invariant_preserved)
explore_tokens = sum(tokens before first edit tool call)
regression_rate = mean(regression_check failed)
report = pivot(category × tool, [success, explore_tok, regression])
```

### CLI

```
gps bench                     # run all tools, all tasks
gps bench --tool gps          # one tool
gps bench --task 002          # one task
gps bench --tools gps,grep-only --repo refund-app
gps bench report results/2026-05-11/
```

### Determinism notes

- Pin agent model + temperature=0 + seed.
- Snapshot repos at fixed SHA per task.
- Re-run N=3 per (tool, task); report median + IQR.
- Token counter from provider response, not estimated.

---

## TL;DR

| | grep-only | vector-rag | **gps** |
|---|---|---|---|
| Success | 47% | 53% | **80%** |
| Explore tokens | 11.4k | 5.2k | **2.1k** |
| Regression rate | 47% | 38% | **22%** |

Simulated. Largest lift on invariant-guarded and caller-ripple tasks. Tied on cross-language. Honest weak spot: reflection/dynamic dispatch (C5). Real benchmark lands week 5; expect noise of ±10pp on success rates, ±25% on token counts.
