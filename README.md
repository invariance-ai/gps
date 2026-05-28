# gps — repo memory for coding agents

> Teach your coding agent how your repo works once. GPS brings that memory back when the relevant code is touched.

`gps` is a memory layer for Claude Code, Codex, Cursor, and shell-based coding agents. It stores the things humans usually have to repeat: repo conventions, best practices, user preferences, invariants, decisions, TODOs, test commands, and hard-won lessons from past edits. Then it retrieves the relevant slice before the agent edits.

```bash
cd your-repo
npx -y @invariance/gps setup --yes --with-claude   # or --with-codex
```

That's it. `setup` initializes `.gps/`, builds the first symbol graph, lifts existing TODO/FIXME comments into notes, and wires your agent. Every non-trivial edit can start with a GPS brief: callers, likely tests, relevant invariants, prior decisions, notes from past edits, and preferences you have taught the agent. At turn end, supported integrations can capture durable lessons back into the memory layer.

> **Pairs with [tars](https://github.com/invariance-ai/tars).** gps gives your agent memory of *your code*; [tars](https://github.com/invariance-ai/tars) teaches it *how to work* — it learns the orchestration method from your cleanest sessions (explore before editing, test before done) and feeds it back on the next prompt. Knowledge + method.

## vs. native Claude Code memory

| | Claude Code native | gps |
|---|---|---|
| **Todos** | Ephemeral — gone at session end | Persisted as notes, anchored to symbols |
| **CLAUDE.md** | Manual — you write and maintain it | Auto-managed block; global lessons land here automatically |
| **Memory feature** | Claude-only | Works identically on Claude Code, Codex, and Cursor |
| **Scope** | File or conversation | Symbol-anchored — surfaces only when that code is touched |
| **Capture** | Manual | Automatic via lifecycle hooks (Claude/Codex); explicit MCP calls (Cursor) |

## Quickstart

One command from the repo root. Pick the agent you use:

```bash
cd your-repo
npx -y @invariance/gps setup --yes --with-claude   # Claude Code
npx -y @invariance/gps setup --yes --with-codex    # Codex CLI
```

Or install multiple integrations at once:

```bash
npx -y @invariance/gps setup --yes --with-cursor
npx -y @invariance/gps setup --yes --with-claude --with-codex --with-cursor
```

`setup` does the full first-run path: writes `.gps/config.yml` and `.gps/invariants.yml`, builds `.gps/index/symbols.json`, lifts `TODO(symbol):` and `FIXME(symbol):` comments into notes, and installs the selected agent integration.

## What gets installed

GPS is CLI-first because coding agents already know how to run shell commands. The installer also writes the native files each agent reads at startup.

| Agent | Install command | What GPS writes | How the agent learns |
|---|---|---|---|
| **Claude Code** | `npx -y @invariance/gps setup --yes --with-claude` | `CLAUDE.md`, `.claude/skills/gps/SKILL.md`, `.claude/settings.json`, `.mcp.json` | The skill and `CLAUDE.md` teach the workflow. Hooks inject context, refresh the index, and capture lessons. MCP exposes `mcp__gps__prepare_edit`. |
| **Codex CLI** | `npx -y @invariance/gps setup --yes --with-codex` | `AGENTS.md`, `.codex/config.toml` | `AGENTS.md` teaches Codex to run `gps prepare` / `gps brief`. MCP exposes structured GPS tools. `notify` captures durable preferences after each turn. |
| **Cursor** | `npx -y @invariance/gps setup --yes --with-cursor` | `.cursor/rules/gps.mdc`, `.cursor/mcp.json` | The always-attached rule teaches the workflow. MCP tools are available for context and explicit memory capture. |

The core loop is the same everywhere. This is the part to remember:

```bash
gps prepare --intent "what I am about to change"   # get the repo-specific brief
gps remember "hard-won fact worth reusing"         # save a durable lesson
gps remember "still need to update the fixture" --reminder --symbol createRefund
gps done                                           # check changed symbols, tests, and invariants before handoff
```

For Claude Code and Codex, GPS can also capture instructions like "always run this test twice" or "in this package, use the errors module" from the session transcript according to your capture policy.

## Copy-paste prompt for Claude Code

If you want Claude Code to install GPS for you, paste this into a Claude Code session at the root of your repo:

```text
Install GPS for this repository and verify it is wired for Claude Code.

GPS npm package: https://www.npmjs.com/package/@invariance/gps
GPS GitHub repo: https://github.com/invariance-ai/gps

Run:
  npx -y @invariance/gps setup --yes --with-claude

Then verify:
  gps validate --root "$PWD"
  test -f CLAUDE.md
  test -f .claude/skills/gps/SKILL.md
  test -f .claude/settings.json
  test -f .mcp.json

After setup, briefly explain what changed and show me the first GPS command I should use before a non-trivial edit.
```

Prefer a global install? Use one shell line:

```bash
npm install -g @invariance/gps && gps setup --yes --with-claude
```

Optional starter packs are still explicit because they depend on your stack:

```bash
gps invariant init --stack stripe
```

Want the long version? See [`docs/guide/getting-started.md`](docs/guide/getting-started.md) for the 10-minute walkthrough, [`docs/guide/commands.md`](docs/guide/commands.md) for the full CLI reference, and the install guides for [`Claude Code`](docs/guide/agents/claude.md), [`Codex CLI`](docs/guide/agents/codex.md), and [`Cursor`](docs/guide/agents/cursor.md).

Launching or evaluating the project? [`docs/launch-audit.md`](docs/launch-audit.md) has the MVP bar, benchmark claims that are safe to cite, X thread beats, and the npm smoke checklist. [`docs/product-hunt.md`](docs/product-hunt.md) has launch copy.

## Capture & promotion policy

Every installer (`claude` / `codex` / `cursor`) takes governance flags that persist to `.gps/config.yml`:

```bash
gps install codex --capture=inbox              # captured memory waits in `gps inbox` for review
gps install codex --capture=auto --promote=safe     # capture live, auto-promote safe clusters (default)
gps install codex --capture=auto --promote=never    # capture live, keep promotion manual
gps install codex --capture=auto --promote=all      # auto-graduate everything — visibly dangerous
gps install claude --auto-suggest                   # feature flag: hook prints authoring-queue nudges
```

Three independent axes:

- **`--capture`** — where freshly captured memory lands. `auto` (default) persists it live, exactly as today. `inbox` queues it for human approval via `gps inbox` before anything activates.
- **`--promote`** — whether recurring note clusters auto-graduate into invariants. `safe` (default with `capture=auto`) auto-promotes, but holds back any cluster touching a `require_approval_for` risk topic (auth, payments, billing, security, migrations, compliance, destructive actions). `never` keeps promotion manual (`gps promote <symbol>`). `all` promotes everything that clusters and **bypasses the risk gate** — the installer prints a loud warning, and it only applies with `--capture=auto`.
- **`--auto-suggest`** — default off. When enabled, supported hooks may run `gps suggest --auto` at turn end and print a short authoring queue: hot or failure-prone symbols that still lack notes/invariants, plus lessons near promotion. It also configures MCP as `gps serve --observe` so the queue has metadata. It never writes memory by itself.

Defaults (`capture=auto`, `promote=safe`, `auto_suggest=false`) make memory useful immediately while still gating risky topics. If you choose `capture=inbox`, promotion defaults to manual because humans are already reviewing memory before activation.

Run `gps inbox` to review queued captures, and `gps promote --auto` to apply the promotion policy (add `--dry-run` to preview). Both read the policy from `.gps/config.yml`. Override the policy for a single run with `gps promote --auto=safe` (or `=never` / `=all`).

## Experimental live docs

`gps doc` generates stable local HTML and Markdown docs for a PR or local diff.
The live browser view is launch-labeled experimental and stays off unless you
opt in explicitly:

```bash
gps doc --experimental-live-docs                    # write .gps/docs/live.html
gps doc --experimental-live-docs --serve            # local browser view for IDE panes
```

To opt in persistently for a repo, set:

```yaml
experimental:
  live_docs: true
```

The server binds to `127.0.0.1` by default, regenerates on refresh, and is
intended for local preview only while the UX settles.

## 60-second demo: correction → reuse

The launch demo should show one thing clearly: an agent makes or nearly makes a repo-specific mistake, GPS captures the correction, and the next edit sees it before touching code.

```console
$ gps prepare refundEndpoint --intent "return a typed error on overflow"
# prepare_edit: refundEndpoint
# ... no directive about errors yet ...

# Developer correction during the session:
# "In apps/api, don't build error strings inline — use the errors module."

$ gps remember "in apps/api, don't build error strings inline — use the errors module" --area apps/api
remembered area note for apps/api

$ gps prepare refundEndpoint --intent "return a typed error on overflow"
# prepare_edit: refundEndpoint
## Directives for this path
- **[area: `apps/api`]** in apps/api, don't build error strings inline — use the errors module

$ gps done
# pre-final check: changed symbols, relevant memory, likely tests, missing coverage
```

That is the product: teach the agent once, then make the relevant lesson hard to miss.

## Governed demo: correction → review → reuse

The full loop — an agent gets context, a developer's correction is captured for review, a human approves it, and the next session inherits it:

```console
# 1. Install with capture=inbox so corrections queue for review (nothing activates silently).
$ npx -y @invariance/gps setup --yes --with-claude --capture=inbox

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

Corrections about test coverage are treated as first-class memory. If a user says
"No, bad Codex, you need to write more tests" after a prepared edit, the Stop/notify
capture path records a `user-correction` note on the last prepared symbol even when
no LLM API key is configured. Future `gps prepare <symbol>` calls then surface that
testing correction before the next edit.

Agents can also save their own hard-won findings:

```bash
gps lessons record "Refund approval tests live in apps/api/src/refund-approval.test.ts"
gps lessons record "The Stripe webhook entrypoint is stripeWebhook in apps/api/src/webhooks.ts"
```

The rule of thumb: if finding it took real search, record it once so the next
agent does not repeat the search loop.

## How Claude Code knows to use gps

`gps setup --yes --with-claude` installs three Claude Code integration points:

- `CLAUDE.md` — a managed gps block with always-loaded repo instructions and global lessons.
- `.claude/skills/gps/SKILL.md` — a Claude Code skill that auto-loads when you're editing code or starting a task.
- `.claude/settings.json` and `.mcp.json` — non-blocking hooks plus the gps MCP server.

So yes: Claude Code learns the workflow through `CLAUDE.md`, and the skill/hooks make it active. The hooks inject context on session start and prompts, refresh the index around edits, record failed shell commands against the active symbol, and distill useful session learnings at the end. The MCP entry exposes the same context as tools, with `mcp__gps__prepare_edit` as the preferred structured entry point.

If you only want the portable Claude Code skill, the important file is:

```text
.claude/skills/gps/SKILL.md
```

That skill is enough to teach Claude the loop: prepare before edits, remember hard-won facts, and run the pre-finalize brief. The one-command setup writes the skill for you and also adds hooks/MCP so the behavior is automatic instead of purely instructional.

To inspect what Claude sees:

```bash
cat CLAUDE.md
cat .claude/skills/gps/SKILL.md
```

The skill tells Claude to:
1. Run `gps prepare <symbol>` (or call `mcp__gps__prepare_edit`) before non-trivial edits
2. Save hard-won repo facts with `gps remember "<fact>"`
3. Run `gps done` before handing work back
4. Treat `gps preferences` output as standing constraints every session

## How it works

Three inputs compound on a single symbol graph:
1. **Static structure** — calls, callers, tests, provenance (the spine)
2. **Human intent** — notes, decisions, invariants (what's worth knowing)
3. **Agent behavior** — what they asked, what they broke (the signal)

Day one, gps is useful for context. Six months in, the notes-and-invariants layer is an asset every new engineer and every new agent depends on. Operational reality, encoded and made queryable. That's the thesis.

## CLI

### Start here

The whole happy path is one setup command, then normal agent usage:

```bash
gps setup --yes --with-claude                         # init + index + TODO lift + Claude wiring
gps prepare <symbol> --intent "<one-liner>"           # decision-ready brief before edits
gps remember "<one sentence>"                         # save hard-won repo facts
gps remember "still need to update the fixture" --reminder --symbol <symbol>
gps done                                              # post-edit self-audit
gps doc --base HEAD                                   # optional shareable review doc for the diff
```

That is the launch surface. Everything below is the larger surface for power users and automation.

### Advanced command map

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
gps remember "still need to update the fixture" --reminder --symbol createRefund     # agent/human reminder
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

Run `gps --help` for the curated launch surface. Advanced commands are still available with `gps <command> --help`; the full generated reference lives in [`docs/guide/commands.md`](docs/guide/commands.md).

### Passive observer — opt-in, metadata only

`gps serve --observe` records *which symbol was queried* and *when*, into `.gps/observations.json`. **Nothing else.** No tool arguments beyond the symbol name, no tool results, no conversation content. The privacy line: gps never persists what an agent asked or what it received — only that `createRefund` was looked at 6 times this week.

`gps suggest` reads those counts and surfaces the symbols agents touch a lot that have no covering invariant. The agent's repeated confusion becomes the **authoring queue** — what's worth writing an invariant or note for next. To try automatic nudges in Claude Code, reinstall with `gps install claude --auto-suggest`; the hook runs `gps suggest --auto`, which is silent unless `.gps/config.yml` has `auto_suggest: true`.

All read commands accept `--json` (stable contract for tool chaining) or `--markdown` (LLM-optimal). ANSI colors auto-strip when piped.

## Claude Code, Codex, Cursor: CLI first

Coding agents already have Bash. Treat `gps` like `rg`: a local command the agent runs before and after edits. This is the primary integration surface.

For **Claude Code**, the installer wires five non-blocking hooks: `SessionStart` (rebuilds the index, prints standing preferences), `UserPromptSubmit` (auto-loads context for symbols named in your prompt), `PreToolUse` Edit/Write (refreshes the index), `PostToolUse` Bash (records failures against the last-prepared symbol), and `Stop` (distills the session into Decisions):

```bash
npx -y @invariance/gps setup --yes --with-claude
```

Claude learns from `.claude/skills/gps/SKILL.md` and `CLAUDE.md`; hooks and MCP make the same behavior automatic.

For **Codex CLI**, the installer writes `AGENTS.md` instructions, registers `gps serve` as an MCP server, and configures a `notify` hook that distills each turn — auto preference and directive capture happen via this hook:

```bash
npx -y @invariance/gps setup --yes --with-codex
```

Codex learns from the `AGENTS.md` block. The `notify` hook captures durable instructions after each turn, and the MCP server exposes the same context tools.

For **Cursor**, the installer writes a `.cursor/rules/gps.mdc` always-attached rule and registers `gps serve` in `.cursor/mcp.json`. Because Cursor has no lifecycle hooks, the agent must call `record_preference` and `record_directive` MCP tools explicitly on durable and location-scoped instructions:

```bash
npx -y @invariance/gps setup --yes --with-cursor
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

On Django (8 symbols), a gps brief averaged **819 tokens at 85% recall** vs ripgrep's **34,717 tokens at 56% recall** — roughly 98% fewer tokens for this symbol-brief benchmark. This measures targeted context retrieval, not total agent productivity.

| tool | tokens (mean) | tokens (p95) | recall | callers | callees | tests |
|---|---|---|---|---|---|---|
| **gps-brief** | **819** | 2,185 | **85%** | 54% | 100% | 100% |
| gps-full | 2,487 | 8,851 | — | — | — | — |
| rg | 34,717 | 129,351 | 56% | 27% | 60% | 80% |
| codebase-memory-mcp | 450 | 1,265 | 47% | 40% | 60% | 40% |

Source: [`bench/perf/results/compare-django-2026-05-16.md`](bench/perf/results/compare-django-2026-05-16.md). Recall is judged by a separate LLM extracting answers from each tool's output, scored against the gps structural oracle. The careful claim is: GPS can return a much smaller, more focused symbol brief than text search on this benchmark. **We do not claim end-to-end productivity gains from this measurement.**

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
