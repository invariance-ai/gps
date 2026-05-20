# gps

> The repo that gets smarter every time you use it.

`gps` gives coding agents — Claude Code, Codex, Cursor — the slice of repo context they'd otherwise miss: symbols, callers and callees, tests that protect each function, recent git history, declarative invariants you author once ("refunds over $1000 require finance approval"), and **lessons learned from previous edits** that agents and humans persist as they go. Anchored to symbols, recorded once, surfaced when relevant.

In a blinded judge run against vanilla Claude Code on a real internal repo (309 source files, 10 prompts, Sonnet judge, A/B-swapped), **gps answers won 13 of 19 valid comparisons (+11% overall quality)**:

| dimension | baseline | gps |
|---|---:|---:|
| correctness | 4.15 | **4.20** |
| specificity | 4.15 | **4.70** |
| completeness | 3.80 | **4.50** |
| **overall (1–5)** | **4.03** | **4.47** |

Methodology and raw numbers: [`bench/dogfood/2026-05-12-invariance-platform.md`](bench/dogfood/2026-05-12-invariance-platform.md).

**Tokens aren't the story.** `claude -p` explores via Glob/Read regardless of injected context; gps is additive there (+1.4% input tokens on the run above). The win is what the agent does *with* that exploration — gps answers cite real symbols and line numbers (`replayRun:14`, `applyMutations:58`) where baseline hand-waves at file-level.

Three inputs compound on a single symbol graph:
1. **Static structure** — calls, callers, tests, provenance (the spine)
2. **Human intent** — notes, decisions, invariants (what's worth knowing)
3. **Agent behavior** *(v0.3)* — what they asked, what they broke (the signal)

Day one, gps is useful for context. Six months in, the notes-and-invariants layer is an asset every new engineer and every new agent depends on. Operational reality, encoded and made queryable. That's the thesis.

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

## What gps is not (yet)

Honest, up-front:

- **Parser is regex-based** for TS/JS/Python — ~90% precision on typical code, lower on decorators-as-factories, dynamic dispatch, and heavy macros. Trade-off documented in [`packages/core/src/parser.ts:5`](packages/core/src/parser.ts). Tree-sitter (WASM) is the next accuracy step.
- **No semantic import resolution.** Re-exports and barrel files may miss call edges.
- **No cross-repo / monorepo-aware symbol IDs** yet — each repo is its own graph.
- **Proof base is n=1.** The +11% quality win above is one repo, 10 prompts. We're running this against more repos next; see [`docs/dogfood-runbook.md`](docs/dogfood-runbook.md) and contribute a result.

## CLI

### Start here — the Core 5

The whole happy path is five commands:

```bash
gps init                                              # 1. write .gps/config.yml + invariants.yml
gps install claude                                    # 2. wire CLAUDE.md + .claude hooks (or: install codex)
gps index                                             # 3. build the symbol graph
gps prepare <symbol> --intent "<one-liner>"           # 4. ⭐ decision-ready brief before edits
gps lessons record "<one sentence>"                   # 5. record what an edit taught you
```

Everything below is the full surface for power users and automation.

### Full command reference

```bash
# Reading
gps prepare <symbol> --intent "what you'll change"   # ⭐ decision-ready brief
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
gps serve --observe                                   # ⚡ opt-in: record per-symbol query counts (metadata only)
gps suggest                                           # surface symbols agents ask about repeatedly with no covering invariant
```

Run `gps --help` for the full 49-command surface (postmortem, promote, gate, runtime, audit, …).

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

For **Codex CLI**, the installer writes `AGENTS.md` instructions, registers `gps serve` as an MCP server, and configures a `notify` hook that distills each turn:

```bash
npx -y @invariance/gps install codex
```

For **Cursor**, the installer writes a `.cursor/rules/gps.mdc` always-attached rule and registers `gps serve` in `.cursor/mcp.json`:

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

v0.2 (alpha). Working CLI + MCP. Ships structural context plus tests, provenance, invariants, notes, and decisions. The current index is a scoped symbol graph with stable symbol IDs, qualified names, file-aware call edges, and test-file tracking. It still uses a zero-native-deps regex parser for TS/JS/Python (see [What gps is not (yet)](#what-gps-is-not-yet)); tree-sitter WASM and LSP-backed reference resolution are the next accuracy step. Single-file JSON index — SQLite when repos push past ~500k LOC.

v0.3 roadmap: passive metadata observer (`gps observe` — symbol query frequencies only, never conversation content) + `gps suggest` for the invariant authoring queue + LLM-assisted postmortem promotion.

v0.4 roadmap: session anchoring (`gps attach --session`) — distill a Claude Code / Codex thread into structured `Decision` records attached to the symbols touched.

## License

MIT. Built by [Invariance](https://invariance.ai).
