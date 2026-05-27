# Product Hunt launch copy

## Tagline

Repo memory for Claude Code, Codex, and Cursor.

## Short description

GPS gives coding agents a durable memory layer for your repo: best practices, preferences, invariants, decisions, test commands, and lessons from past edits. Install it once, teach it what matters, and the relevant context comes back when the agent touches that code.

## Product description

Coding agents are strong at the current prompt and weak at remembering how your repo works.

GPS fixes that by adding a local memory layer beside your code. It indexes symbols, callers, tests, TODOs, and provenance, then lets you add the human context agents usually miss: "run this test twice before done", "do not log PII here", "use the errors module in apps/api", "we rejected this approach last quarter", "this helper is the blessed path".

Before an edit, the agent runs:

```bash
gps prepare --intent "what I am about to change"
```

GPS returns a focused brief: relevant files, callers, likely tests, invariants, notes, prior decisions, and preferences. Before the agent hands work back, `gps brief` checks changed symbols against the memory that applies.

The same memory works across Claude Code, Codex, Cursor, and shell-based agents:

```bash
npx -y @invariance/gps setup --yes --with-claude
npx -y @invariance/gps setup --yes --with-codex
npx -y @invariance/gps setup --yes --with-cursor
```

Claude Code gets a skill, hooks, `CLAUDE.md`, and MCP. Codex gets `AGENTS.md`, MCP, and a `notify` hook that can capture durable preferences after a turn. Cursor gets an always-attached rule and MCP.

The core idea is simple: stop re-explaining the same repo context every session. Save it once. Retrieve the relevant slice when it matters.

## First comment

I built GPS because I kept watching coding agents repeat the same mistakes after I had already corrected them.

The annoying part was not code search. It was repo-specific memory:

- "In this folder, use the shared errors module."
- "Run the targeted test twice before calling refund work done."
- "Do not log member identifiers in payer/audit logs."
- "This decision was made already; do not reopen it unless the constraints changed."
- "This test file is the one that actually protects the path."

Those facts usually live in a developer's head, a stale doc, a Slack thread, or a correction buried in a chat transcript. GPS turns them into local repo memory that agents can retrieve before editing.

Install for Claude Code:

```bash
npx -y @invariance/gps setup --yes --with-claude
```

That writes:

- `CLAUDE.md` instructions
- `.claude/skills/gps/SKILL.md`
- Claude Code hooks
- `.mcp.json` for the GPS MCP server

Install for Codex:

```bash
npx -y @invariance/gps setup --yes --with-codex
```

That writes:

- `AGENTS.md` instructions
- `.codex/config.toml`
- a GPS MCP server entry
- a `notify` hook for turn-end memory capture

GPS is local-first and CLI-first. MCP is available where the agent supports it, but the basic workflow is just:

```bash
gps prepare --intent "what I am about to change"
gps remember "hard-won repo fact"
gps brief
```

The careful claim: GPS does not guarantee an agent will never make mistakes. It makes the important repo context much harder to miss.

## Launch bullets

- Durable memory for coding agents: preferences, directives, notes, decisions, invariants, TODOs, and tests.
- Symbol-anchored retrieval: context shows up when the relevant code is touched.
- Works with Claude Code, Codex, Cursor, and shell-based agents.
- CLI-first, with MCP tools where supported.
- Claude Code integration: skill, hooks, `CLAUDE.md`, and MCP.
- Codex integration: `AGENTS.md`, MCP, and turn-end `notify` capture.
- Governance options: capture live or queue memory in `gps inbox` for review.

## X thread outline

1. Coding agents do not need every repo rule pasted into every prompt. They need the right repo memory before edits.
2. `gps prepare` returns the focused brief: files, callers, tests, invariants, notes, decisions, and preferences.
3. `gps remember` turns a correction or hard-won fact into durable memory.
4. Location-scoped directives keep local conventions attached to the directory or feature where they matter.
5. Related memory follows the work: a lesson from one symbol can resurface when the next task touches nearby code.
6. `gps brief` gives the agent a pre-final check against changed symbols, tests, and invariants.
7. Install once for Claude Code or Codex; stop re-explaining the same context every session.

## Claims to avoid

- Do not say GPS guarantees correctness.
- Do not claim broad productivity percentages without citing a benchmark.
- Do not imply Codex has a pre-tool hook. Codex learns from `AGENTS.md`, uses MCP, and captures after turns through `notify`.
- Do not imply all captured memory is always active. Teams can use `--capture=inbox` to review memory before activation.
