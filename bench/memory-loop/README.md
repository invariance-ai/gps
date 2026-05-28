# gps memory-loop benchmark plan

This benchmark is for the product claim: agents should stop forgetting human
corrections and hard-won repo findings.

It is intentionally separate from graph/token benchmarks. The unit under test is
the feedback loop:

1. Agent works on a symbol.
2. Human corrects the agent or the agent discovers a non-obvious fact.
3. gps captures the memory.
4. A later run gets the memory before editing.
5. The later run behaves better than a no-gps baseline.

## Arms

| Arm | Setup |
|---|---|
| baseline | No `.gps/`, no MCP, no repo instruction beyond the task prompt |
| gps-manual | `gps init`, `gps index`, agent instructed to run `gps prepare` and `gps lessons record` |
| gps-hooks | `gps install claude|codex --capture=inbox --auto-suggest`, MCP enabled, hooks/notify enabled |

For Codex programmatic runs, use the cheapest model/plan that can edit code
reliably. Keep prompts byte-identical between arms; the only difference should be
whether gps is installed and discoverable.

## Task Classes

### 1. Human Correction: Missing Tests

Round 1 prompt:

```text
Change createRefund so non-enterprise refunds above $5000 require approval.
```

Injected human correction after the first attempt:

```text
No, bad Codex, you need to write more tests before calling this done.
```

Expected gps memory:

```text
When editing createRefund, add or strengthen tests before declaring the task done.
```

Round 2 prompt:

```text
Make a small change to createRefund's approval message.
```

Score:

- Did the agent run or edit the relevant tests?
- Did `gps prepare createRefund` surface the prior testing correction?
- Did the final diff include meaningful coverage?

### 2. Hard-Won Location: Hidden Test Path

Round 1 prompt:

```text
Find where refund approval edge cases are tested.
```

Expected gps memory from the agent:

```text
Refund approval tests live in apps/api/src/refund-approval.test.ts.
```

Round 2 prompt:

```text
Add a regression test for refund approval thresholds.
```

Score:

- Time/commands before opening the right test file.
- Whether the right path appears in the initial plan.
- Whether the baseline repeats the search.

### 3. Hard-Won Entrypoint: Non-Obvious Handler

Round 1 prompt:

```text
Find the Stripe webhook entrypoint and explain how retries are handled.
```

Expected gps memory:

```text
The Stripe webhook entrypoint is stripeWebhook in apps/api/src/webhooks.ts.
```

Round 2 prompt:

```text
Add logging around Stripe webhook retry failures.
```

Score:

- Did the agent start from the correct file/symbol?
- Did it avoid editing nearby but wrong webhook helpers?

## Metrics

- First useful file opened.
- Number of search/read commands before the right symbol.
- Whether relevant tests were edited or run.
- Whether captured memory appeared in `gps prepare`.
- Whether the second run repeats the first run's mistake.
- Tokens to first correct file.
- Wall-clock to first correct file.

## Acceptance Bar

The launch claim should be limited to this shape:

> gps helps agents reuse prior corrections and hard-won repo findings across
> sessions.

Do not claim broad productivity lift from this benchmark unless the task set is
large enough and prompts are fair across arms.

## Live OpenAI Planning Experiment

Run the cheap planning-only harness:

```bash
pnpm build
OPENAI_MODEL=gpt-5.1-codex-mini pnpm bench:memory:openai
```

The runner creates a temporary fixture repo, initializes gps, simulates the
human correction "No, bad Codex, you need to write more tests", runs
`gps plan` and `gps prepare`, then asks the same OpenAI Responses API model for
a baseline plan and a gps-backed plan. Results are written to:

```text
bench/memory-loop/results/<timestamp>/
```

This is not a full coding benchmark. It is a low-cost smoke test for whether
GPS memory changes the next plan in the expected direction.

Latest local run:

```text
2026-05-26, gpt-5.1-codex-mini
baseline: 2/5
gps:      4/5
result:   bench/memory-loop/results/2026-05-26T19-54-00-939Z/
```

In that run, the baseline planned a wording-only edit and explicitly skipped
tests. The gps-backed plan opened `src/refunds.test.ts`, planned test updates,
and planned to run the relevant test.
