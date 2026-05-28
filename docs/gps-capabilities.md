# GPS Capabilities

GPS is a memory layer for coding agents. It helps Claude Code, Codex, Cursor, and shell-based agents remember how a repo works: code structure, tests, invariants, preferences, directives, decisions, repeated failures, and hard-won lessons from prior edits.

## One-Command Setup

```bash
npx -y @invariance/gps setup --yes --with-claude
npx -y @invariance/gps setup --yes --with-codex
npx -y @invariance/gps setup --yes --with-cursor
```

Setup initializes `.gps/`, builds the first symbol graph, lifts `TODO(symbol):` and `FIXME(symbol):` comments into notes, and installs the selected agent integration.

## Agent Integrations

| Agent | What GPS Writes | How the Agent Learns |
|---|---|---|
| Claude Code | `CLAUDE.md`, `.claude/skills/gps/SKILL.md`, `.claude/settings.json`, `.mcp.json` | The skill and `CLAUDE.md` teach the workflow. Hooks inject context and capture lessons. MCP exposes tools like `mcp__gps__prepare_edit`. |
| Codex CLI | `AGENTS.md`, `.codex/config.toml` | `AGENTS.md` teaches Codex to run GPS commands. `notify` captures durable instructions after each turn. MCP exposes structured GPS tools. |
| Cursor | `.cursor/rules/gps.mdc`, `.cursor/mcp.json` | The always-attached Cursor rule teaches the workflow. MCP tools provide context and explicit memory capture. |

## Core Agent Loop

```bash
gps prepare <symbol> --intent "<what you plan to change>"
gps remember "<hard-won fact worth reusing>"
gps remember "still need to update the fixture" --reminder --symbol <symbol>
gps brief
gps done
```

- `gps prepare` gives the agent a decision-ready brief before edits.
- `gps remember` saves facts the next agent should not have to rediscover.
- `gps remember --reminder` saves unfinished work or follow-up reminders for the next agent, the human, or both.
- `gps brief` checks changed symbols, invariants, notes, tests, and missing coverage before finalizing.
- `gps done` runs the post-edit self-audit flow.

## Experimental Live Docs

The live HTML documentation view is available as an explicitly experimental local preview:

```bash
gps doc --experimental-live-docs
gps doc --experimental-live-docs --serve
```

It surfaces the current diff, changed symbols, relevant memory, tests, blocking invariants, pending inbox items, and the full `gps brief` markdown. The server binds to `127.0.0.1` by default so it can be opened in browser panes inside online IDEs. Persistent opt-in is `experimental.live_docs: true` in `.gps/config.yml`.

## Context GPS Can Surface

- Symbols, definitions, callers, and call edges.
- Files related to a symbol.
- Tests likely to protect the touched code.
- Invariants and blocking rules.
- Prior decisions and rejected alternatives.
- Notes and lessons from previous edits.
- User preferences and team practices.
- Location-scoped directives.
- Stale memories marked as stale instead of presented as fresh facts.
- Recent failures and repeated mistake patterns.

## Memory Capture

GPS can store several kinds of memory:

- **Hard-won facts:** `gps remember "Refund tests live in src/refunds.test.ts"`.
- **Agent reminders:** `gps remember "still need to update the payer denial fixture" --reminder --symbol routeToPayer`.
- **Human handoff reminders:** `gps remember "confirm rollback plan before merge" --reminder --for both --symbol runMigration`.
- **Lessons:** `gps lessons record "<one sentence>"`.
- **Preferences:** durable user/team rules like “always write tests for this package.”
- **Directives:** location-scoped instructions like “in apps/api, use the errors module.”
- **Decisions:** choices and rejected alternatives with rationale.
- **Test commands:** exact commands that worked for a symbol or file.
- **Failures:** broken commands, failed tests, and recurring agent mistakes.

## Review And Governance

GPS supports both automatic and reviewed capture:

```bash
gps install claude --capture=auto
gps install claude --capture=inbox
gps inbox
gps inbox approve <id>
gps inbox reject <id>
```

- `capture=auto` activates captured memory immediately.
- `capture=inbox` queues memory for human review.
- `gps review-memory` provides a review flow for captured memories.
- `gps promote --auto=safe` can promote recurring lessons while holding back risky topics.
- Risk topics include auth, payments, billing, security, migrations, compliance, and destructive actions.

## Search And Discovery

```bash
gps find "<keyword>"
gps context <symbol>
gps impact <symbol>
gps tests <symbol>
gps invariants <symbol>
gps trace <symbol>
```

These commands help agents find existing helpers, understand blast radius, identify tests, and avoid re-implementing code that already exists.

## Hard Search Detection

GPS can observe when an agent spends a long time searching and then suggest saving the result:

```text
GPS saw 9 search/read commands without a prior prepare brief.
next time: gps prepare --intent '<what you are about to change>'
remember:  gps remember 'src/webhooks.ts is the relevant location for stripeWebhook' --symbol 'stripeWebhook'
```

This turns expensive repo exploration into reusable memory and teaches the next agent to use GPS earlier.

## Test Command Learning

GPS can remember exact test commands for symbols and files:

```bash
gps test-record --symbol createRefund -- pnpm --filter api test refunds.test.ts
gps tests createRefund
```

Future agents can reuse the command instead of guessing the package, runner, or filter syntax.

## Subagent Packets

```bash
gps packet <symbol>
```

`gps packet` emits a compact task bundle for subagents: symbol, files, tests, invariants, notes, recent failures, expected commands, and relevant memory.

## Feature And Area Memory

```bash
gps feature use checkout-flow
gps directive add "use the errors module" --area apps/api
gps alias set home --file src/pages/home.tsx --feature homepage
```

GPS can bind memory to features, files, directories, areas, and aliases so guidance appears only where it is relevant.

## Staleness And Confidence

GPS tracks stale memories instead of treating old notes as equally reliable forever:

```bash
gps stale
```

Old or low-confidence memories can be surfaced as stale context, reviewed, refreshed, or ignored.

## Suggestions And Mistake Patterns

```bash
gps suggest
gps record-failure --symbol createRefund --kind test --message "missing schema generation"
```

GPS can surface:

- Hot symbols agents ask about repeatedly.
- Symbols without enough notes or invariants.
- Lessons near promotion.
- Repeated failures like “agents forget `pnpm gen:schemas` after schema edits.”
- Agent-friction memories worth saving, with concrete `gps remember ...` commands.

## Benchmarks And Launch Validation

```bash
gps bench tasks
gps bench run
gps bench report
```

GPS includes a repo-edit benchmark harness for comparing agents with and without GPS across tasks like hidden tests, hidden entrypoints, human corrections, invariant violations, wrong-package edits, and generated-file drift.

## What Makes GPS Different

GPS is not just a long prompt or generic memory file. It is:

- Repo-local.
- CLI-first.
- Agent-agnostic.
- Symbol-anchored.
- Reviewable.
- Staleness-aware.
- Connected to tests and invariants.
- Designed to retrieve the right memory only when the relevant code is touched.
