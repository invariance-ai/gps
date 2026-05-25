# gps — plug-in memory layer for your coding agents

> One install. Durable, automatic, symbol-anchored repo memory for Claude Code, Codex, and Cursor.

`gps` gives Claude Code, Codex, and Cursor the memory they're missing: notes, decisions, preferences, and invariants anchored to symbols, captured automatically by lifecycle hooks, and surfaced only when the relevant code is touched.

```bash
cd your-repo
npx -y @invariance/gps install claude      # or: install codex | install cursor
npx -y @invariance/gps index
```

That's it. The agent now has a memory layer. Every session starts with your standing preferences. Every edit on a non-trivial symbol is preceded by a brief — invariants, callers, tests, prior decisions, notes from past edits. Every session end distills what was learned back into the graph.

## vs. native Claude Code memory

| | Claude Code native | gps |
|---|---|---|
| **Todos** | Ephemeral — gone at session end | Persisted as notes, anchored to symbols |
| **CLAUDE.md** | Manual — you write and maintain it | Auto-managed block; global lessons land here automatically |
| **Memory feature** | Claude-only | Works identically on Claude Code, Codex, and Cursor |
| **Scope** | File or conversation | Symbol-anchored — surfaces only when that code is touched |
| **Capture** | Manual | Automatic via lifecycle hooks (Claude/Codex); explicit MCP calls (Cursor) |

## Quickstart

No install required — `npx` runs the latest published version each time:

```bash
cd your-repo
npx -y @invariance/gps init                # writes .gps/config.yml + .gps/invariants.yml
npx -y @invariance/gps install claude      # writes CLAUDE.md + .claude skill/hooks + .mcp.json
npx -y @invariance/gps install codex       # writes AGENTS.md + .codex/config.toml (notify + MCP)
npx -y @invariance/gps install cursor      # writes .cursor/rules/gps.mdc + .cursor/mcp.json
npx -y @invariance/gps index               # builds the symbol graph
npx -y @invariance/gps learn-todos         # bootstrap notes from existing TODO/FIXME
npx -y @invariance/gps invariant init --stack stripe   # optional: drop in a starter pack
```

Prefer a global install? `npm install -g @invariance/gps`, then drop the `npx -y` prefix and pass `--use-global` to the installers so generated hooks/MCP entries call `gps` directly instead of `npx`.

Want the long version? See [`docs/guide/getting-started.md`](docs/guide/getting-started.md) for the 10-minute walkthrough, [`docs/guide/commands.md`](docs/guide/commands.md) for the full CLI reference, and [`docs/guide/agents/`](docs/guide/agents/) for per-IDE setup details.

## Capture & promotion policy

Every installer (`claude` / `codex` / `cursor`) takes two governance flags that persist to `.gps/config.yml`:

```bash
gps install codex --capture=inbox              # captured memory waits in `gps inbox` for review
gps install codex --capture=auto --promote=never   # capture live, never auto-graduate (default)
gps install codex --capture=auto --promote=safe     # auto-graduate clusters, except risky topics
gps install codex --capture=auto --promote=all      # auto-graduate everything — visibly dangerous
```

Two independent axes:

- **`--capture`** — where freshly captured memory lands. `auto` (default) persists it live, exactly as today. `inbox` queues it for human approval via `gps inbox` before anything activates.
- **`--promote`** — whether recurring note clusters auto-graduate into invariants. `never` (default) keeps promotion manual (`gps promote <symbol>`). `safe` auto-promotes, but holds back any cluster touching a `require_approval_for` risk topic (auth, payments, billing, security, migrations, compliance, destructive actions). `all` promotes everything that clusters and **bypasses the risk gate** — the installer prints a loud warning, and it only applies with `--capture=auto`.

Defaults (`capture=auto`, `promote=never`) preserve current behavior, so existing setups are unaffected.

Run `gps inbox` to review queued captures, and `gps promote --auto` to apply the promotion policy (add `--dry-run` to preview). Both read the policy from `.gps/config.yml`. Override the policy for a single run with `gps promote --auto=safe` (or `=never` / `=all`).

## Demo: correction → review → reuse

The full loop — an agent gets context, a developer's correction is captured for review, a human approves it, and the next session inherits it:

```console
# 1. Install with capture=inbox so corrections queue for review (nothing activates silently).
$ npx -y @invariance/gps init
$ npx -y @invariance/gps install claude --capture=inbox
$ npx -y @invariance/gps index

# 2. The agent prepares an edit and gets structure, tests, invariants, and risk.
$ gps prepare createRefund --intent "add $5000 cap for non-enterprise"
# prepare_edit: createRefund
**Risk:** HIGH
## Invariants that apply
- **High-value refunds require approval** (block) — Refunds over 1000 require finance_approval_id.

# 3. Mid-task the developer corrects the agent. The capture hook queues it (capture=inbox):
#    "in apps/api, don't build error strings inline — use the errors module"
$ gps inbox list
1 item in inbox:

3f9c1a2b8d7e (directive) in apps/api, don't build error strings inline — use the errors module

Approve: `gps inbox approve <id>` · Reject: `gps inbox reject <id>` · Edit: `gps inbox edit <id> --text "…"`

# 4. A human reviews and approves — the directive becomes an area-scoped note.
$ gps inbox approve 3f9c1a2b8d7e
approved 3f9c1a2b8d7e → area note (apps/api)

# 5. Next session: any prepare for a symbol under apps/api now carries the directive.
$ gps prepare refundEndpoint --intent "return a typed error on overflow"
# prepare_edit: refundEndpoint
## Directives for this path
- **[area: `apps/api`]** in apps/api, don't build error strings inline — use the errors module
```

Captured once, approved once — and it now rides along on every edit in that directory, for every future agent and human. `--capture=auto` skips step 4 and activates corrections immediately; `inbox` is the reviewed path.

## The generated skill

`gps install claude` writes `.claude/skills/gps/SKILL.md` — a Claude Code skill that auto-loads whenever you're editing code or starting a task. Paste it yourself if you prefer:

```bash
cat .claude/skills/gps/SKILL.md
```

The skill tells Claude to:
1. Run `gps prepare <symbol>` (or call `mcp__gps__prepare_edit`) before non-trivial edits
2. Run `gps lessons record "<one sentence>"` after edits that taught something
3. Treat `gps preferences` output as standing constraints every session

## How it works

Three inputs compound on a single symbol graph:
1. **Static structure** — calls, callers, tests, provenance (the spine)
2. **Human intent** — notes, decisions, invariants (what's worth knowing)
3. **Agent behavior** — what they asked, what they broke (the signal)

Day one, gps is useful for context. Six months in, the notes-and-invariants layer is an asset every new engineer and every new agent depends on. Operational reality, encoded and made queryable. That's the thesis.

## CLI

### Start here — the Core 5

The whole happy path is five commands:

```bash
gps init                                              # 1. write .gps/config.yml + invariants.yml
gps install claude                                    # 2. wire CLAUDE.md + .claude hooks (or: install codex)
gps index                                             # 3. build the symbol graph
gps prepare <symbol> --intent "<one-liner>"           # 4. decision-ready brief before edits
gps lessons record "<one sentence>"                   # 5. record what an edit taught you
```

Everything below is the full surface for power users and automation.

### Full command reference

```bash
# Reading
gps prepare <symbol> --intent "what you'll change"   # decision-ready brief
gps context <symbol>                                  # multi-strand context
gps impact <symbol>                                   # blast radius
gps tests <symbol>                                    # tests that protect it
gps invariants <symbol>                               # rules that apply
gps find "<query>"                                    # fuzzy symbol search
gps trace <symbol>                                    # git provenance

# Writing — anchored memory
gps lessons record "..."                              # record a lesson; auto-classified global/scoped
gps learn <symbol> --lesson "..." [--severity low|medium|high] [--evidence <ref>]   # legacy: always symbol-scoped
gps notes <symbol>                                    # what previous edits left behind
gps learn-todos                                       # one-shot: lift TODO/FIXME into notes
gps decide <symbol> --decision "..." [--rejected "..."] [--rationale "..."]
gps decisions <symbol>                                # choices recorded, with rejected alternatives

# Server
gps index --watch                                     # rebuild on changes
gps serve                                             # MCP stdio server
gps serve --observe                                   # opt-in: record per-symbol query counts (metadata only)
gps suggest                                           # surface symbols agents ask about repeatedly with no covering invariant
```

Run `gps --help` for the full command surface — 66 top-level commands (postmortem, promote, gate, runtime, audit, …). Full reference: [`docs/guide/commands.md`](docs/guide/commands.md).

### Passive observer — opt-in, metadata only

`gps serve --observe` records *which symbol was queried* and *when*, into `.gps/observations.json`. **Nothing else.** No tool arguments beyond the symbol name, no tool results, no conversation content. The privacy line: gps never persists what an agent asked or what it received — only that `createRefund` was looked at 6 times this week.

`gps suggest` reads those counts and surfaces the symbols agents touch a lot that have no covering invariant. The agent's repeated confusion becomes the **authoring queue** — what's worth writing an invariant or note for next.

All read commands accept `--json` (stable contract for tool chaining) or `--markdown` (LLM-optimal). ANSI colors auto-strip when piped.

## Claude Code, Codex, Cursor: CLI first

Coding agents already have Bash. Treat `gps` like `rg`: a local command the agent runs before and after edits. This is the primary integration surface.

For **Claude Code**, the installer wires five non-blocking hooks: `SessionStart` (rebuilds the index, prints standing preferences), `UserPromptSubmit` (auto-loads context for symbols named in your prompt), `PreToolUse` Edit/Write (refreshes the index), `PostToolUse` Bash (records failures against the last-prepared symbol), and `Stop` (distills the session into Decisions):

```bash
npx -y @invariance/gps install claude
```

For **Codex CLI**, the installer writes `AGENTS.md` instructions, registers `gps serve` as an MCP server, and configures a `notify` hook that distills each turn — auto preference and directive capture happen via this hook:

```bash
npx -y @invariance/gps install codex
```

For **Cursor**, the installer writes a `.cursor/rules/gps.mdc` always-attached rule and registers `gps serve` in `.cursor/mcp.json`. Because Cursor has no lifecycle hooks, the agent must call `record_preference` and `record_directive` MCP tools explicitly on durable and location-scoped instructions:

```bash
npx -y @invariance/gps install cursor
```

For any other shell-based agent, add this to the repo instructions:

```text
You have access to `gps`, a CLI that returns structured repo context.

Before editing any non-trivial symbol, run:
  gps prepare <symbol> --intent "<one-line description>"

After a successful change that taught you something non-obvious, run:
  gps lessons record "<one sentence>"

To check what tests to run after editing:
  gps tests <symbol> --json
```

MCP is optional. `gps serve` exposes the same backend for tool-native clients, but the CLI is the surface to optimize first.

## Anchored memory in action

```text
$ gps prepare createRefund --intent "add $5000 cap for non-enterprise"

# prepare_edit: createRefund

**Intent:** add $5000 cap for non-enterprise
**Defined in:** `apps/api/src/refunds.ts:42` (function)
**Risk:** HIGH

## Called by
- supportRefundWorkflow — apps/api/src/workflows.ts:88
- replayRefundCase — apps/api/src/replay.ts:14

## Tests to run after editing
- apps/api/src/refunds.test.ts (vitest)
- apps/api/src/refund-approval.test.ts (vitest)

## Invariants that apply
- **High-value refunds require approval** (block)
  Refunds over 1000 require finance_approval_id.
  evidence: docs/refund-policy.md

## Notes from previous edits
- **[high]** amount validation must happen before currency conversion
  - evidence: PR-1287
- **[medium]** wrap stripe.refunds.create in withRetry — flaky on Mondays
  - evidence: incident-2026-04-22

## Past decisions
- **validate amount before currency conversion**
  - rejected: validate after conversion (breaks for JPY)
  - rationale: $0.99 USD must not become 99 JPY

## Recent changes
- `a3f2c11` 2026-05-04 alex: added idempotency_key arg
```

The agent doesn't have to re-discover any of this. The lessons came from previous edits — recorded once, surfaced forever, only when relevant.

## Invariants

`gps` is the only OSS tool in its category that surfaces **author-defined invariants** alongside structural context.

```yaml
# .gps/invariants.yml
- name: High-value refunds require approval
  applies_to:
    - createRefund
    - "stripe.refunds.create"
  rule: Refunds over 1000 require finance_approval_id.
  evidence:
    - docs/refund-policy.md
  severity: block
```

Semgrep and CodeQL can match patterns, but they're security-first and not PM-authored. A YAML file with a rule, a link to the policy doc, and `severity: block` is a different artifact — one an LLM cannot reconstruct from a tree-sitter pass.

## Notes vs Invariants vs Decisions

Three artifact types, one symbol anchor:

| Artifact | Shape | Authored by | Promoted to |
|---|---|---|---|
| **Note** | a general lesson | anyone (agent, human, doc, TODO) | invariant (when patterns recur) |
| **Invariant** | a rule that must hold | PM / eng lead | — |
| **Decision** | a choice with rejected alternative | human / agent now, LLM-distilled from sessions later | — |

Notes "deflate" over time — recurring ones get promoted to invariants, and gps stops surfacing the note (the invariant strand picks it up instead). That's the asset-building mechanic.

## How it compares

| Tool | Returns | Notes / memory? | Invariants? | License |
|---|---|---|---|---|
| **gps** | Decision brief: structure + tests + invariants + **notes** + risk | **✅ anchored to symbols** | **✅ first-class** | MIT |
| Sverklo MCP | Ranked chunks + symbols | ❌ | ❌ | MIT |
| CodeGraph / CodeGraphContext / code-graph-mcp | Callers, callees, impact | ❌ | ❌ | OSS |
| Aider repomap | Token-budgeted symbol map | ❌ | ❌ | Apache-2 |
| Sourcegraph Cody | Files, symbols, refs | ❌ | ❌ | Commercial |
| Continue.dev | Chunks + repo map | ❌ | ❌ | Apache-2 |
| Greptile | Review comments | ❌ | ❌ | $20-30/seat |
| Nia / Nozomio | Vector chunks + 3000 packages | ❌ | ❌ | YC S25 |
| Cursor index | Embedded chunks | ❌ | ❌ | Closed |
| Semgrep / CodeQL | Pattern findings | ❌ | Pattern-based (security) | Mixed |

See [docs/competitive-landscape.md](docs/competitive-landscape.md) for the full survey. Measured quality results live in [`bench/dogfood/2026-05-12-invariance-platform.md`](bench/dogfood/2026-05-12-invariance-platform.md); [`docs/simulated-benchmark.md`](docs/simulated-benchmark.md) contains earlier pre-dogfood simulated estimates and is now superseded.

## Native-agent prompt commands

`gps` does not need to own the LLM runtime. For Claude Code and Codex, commands that need reasoning print a prompt package by default; the native agent answers using its own model/session, and `gps` records the resulting YAML or command.

```bash
# Propose an invariant from a regression PR (prints a native-agent prompt)
gps postmortem --pr 1287
gps postmortem --diff-file my.diff --symbol createRefund   # offline alternative

# Find clusters of similar notes that should become invariants
gps promote createRefund                            # rule-based, no API key needed

# Distill a conversation transcript into Decision records
gps attach --transcript path/to/transcript.txt --symbol createRefund --session "PR-1287"

# Extract Decision records from a PR's description, reviews, and comments
gps pr-intent --pr 1287
```

API execution is an explicit opt-in for automation: pass `--call-api` plus `ANTHROPIC_API_KEY` or `--api-key`. The default path is native Claude/Codex.

## Status

v0.1.0 (alpha). Working CLI + MCP. Ships structural context plus tests, provenance, invariants, notes, and decisions — and the **closed feedback loop**: on session end the Stop hook distills the transcript into `Decision` records; `TODO(symbol):` comments sync into notes (and prune when removed) on every SessionStart; recurring lessons fold across rewordings and auto-promote to standing rules once gates pass; captured preferences persist into a managed CLAUDE.md block. The index is a scoped symbol graph with stable symbol IDs, qualified names, file-aware call edges, and test-file tracking. Default parser is tree-sitter (WASM) for TS/JS/Python with a zero-dep regex fallback (see [What gps is not (yet)](#what-gps-is-not-yet)). Single-file JSON index — SQLite when repos push past ~500k LOC.

Also shipping: passive metadata observer (`gps serve --observe` — symbol query frequencies only, never conversation content), `gps suggest` for the authoring queue (now also surfaces lessons near promotion), and LLM-assisted postmortem promotion.

Next: native `gps attach --session <id>` lookup (the Stop hook already auto-distills via the transcript path), LSP-backed reference resolution, and cross-repo / monorepo symbol IDs.

## What gps is not (yet)

Honest, up-front:

- **Parser precision is ~90% on typical code**, lower on decorators-as-factories, dynamic dispatch, and heavy macros. The default backend is tree-sitter (WASM, zero native deps) for TS/JS/Python with body/`end_line` tracking; a regex backend (8 languages) is the fallback. Trade-off documented in [`packages/core/src/parser.ts:5`](packages/core/src/parser.ts). LSP-backed reference resolution is the next accuracy step.
- **No semantic import resolution.** Re-exports and barrel files may miss call edges.
- **No cross-repo / monorepo-aware symbol IDs** yet — each repo is its own graph.
- **Proof base is n=1.** The dogfood quality result above is one repo, 10 prompts. We're running this against more repos next; see [`docs/dogfood-runbook.md`](docs/dogfood-runbook.md) and contribute a result.

## Benchmarks

### Token efficiency (architectural result)

On Django (8 symbols), a gps brief averages **819 tokens at 85% recall** vs ripgrep's **34,717 tokens at 56% recall** — roughly 98% fewer tokens, higher recall. This is an architectural consequence of graph lookup vs text dump: gps fetches exactly the strands relevant to a symbol, ripgrep dumps every matching line.

| tool | tokens (mean) | tokens (p95) | recall | callers | callees | tests |
|---|---|---|---|---|---|---|
| **gps-brief** | **819** | 2,185 | **85%** | 54% | 100% | 100% |
| gps-full | 2,487 | 8,851 | — | — | — | — |
| rg | 34,717 | 129,351 | 56% | 27% | 60% | 80% |
| codebase-memory-mcp | 450 | 1,265 | 47% | 40% | 60% | 40% |

Source: [`bench/perf/results/compare-django-2026-05-16.md`](bench/perf/results/compare-django-2026-05-16.md). Recall is judged by a separate LLM extracting answers from each tool's output, scored against the gps structural oracle. The token/recall advantage is architectural (graph lookup vs text dump). **We do not claim end-to-end productivity gains from this measurement.**

### End-to-end quality (dogfood, n=1 repo)

In a blinded judge run against vanilla Claude Code on a real internal repo (309 source files, 10 prompts, Sonnet judge, A/B-swapped), **gps answers won 13 of 19 valid comparisons (+11% overall quality)**:

| dimension | baseline | gps |
|---|---:|---:|
| correctness | 4.15 | **4.20** |
| specificity | 4.15 | **4.70** |
| completeness | 3.80 | **4.50** |
| **overall (1–5)** | **4.03** | **4.47** |

Methodology and raw numbers: [`bench/dogfood/2026-05-12-invariance-platform.md`](bench/dogfood/2026-05-12-invariance-platform.md).

**Caveats:** Single repo (309 files, our own codebase), n=10 prompts, one LLM judge. These numbers reflect a real measured result but cannot be generalized to arbitrary repos or tasks. We're running this against more repos next. **Do not cite the +11% figure as a general productivity claim.**

## License

MIT. Built by [Invariance](https://invariance.ai).
