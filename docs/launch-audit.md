# gps launch audit

This is the MVP bar for a launch that is genuinely useful rather than just a demo.

## MVP user promise

`gps` should make a coding agent better on day one by giving it the context humans normally repeat:

- what symbol to edit and where it lives
- callers, likely tests, and recent provenance before the edit
- product/engineering invariants with evidence links
- durable preferences and location-scoped directives
- a review path for captured memory before it becomes active

The default loop should stay boring:

```bash
npx -y @invariance/gps init
npx -y @invariance/gps install claude    # or codex | cursor
npx -y @invariance/gps index
gps prepare --intent "what I am about to change"
gps brief
```

## Launch-critical capabilities

| Area | Current status | Launch bar |
|---|---|---|
| npm install | Working package build and `npm pack --dry-run` for `@invariance/gps` | Publish all workspace packages in dependency order; verify `npx -y @invariance/gps --help` from a clean temp repo |
| Claude Code | Skill, hooks, MCP server, CLAUDE.md block | `install claude --dry-run`, `install claude`, then verify `.claude/settings.json`, `.mcp.json`, and `CLAUDE.md` |
| Codex CLI | AGENTS.md, notify hook, MCP server | Verify `.codex/config.toml` has top-level `notify` and `mcp_servers.gps` |
| Cursor | Always-attached rule plus MCP server | Verify `.cursor/rules/gps.mdc` and `.cursor/mcp.json` |
| Memory governance | `capture=auto|inbox`, `promote=never|safe|all` | Default remains non-breaking; recommend `--capture=inbox` for teams |
| Auto suggestions | Feature flag: `auto_suggest=false` by default, enabled by `--auto-suggest` | Hook-safe `gps suggest --auto` must never write memory and must no-op unless enabled |
| Benchmarks | Measured perf and dogfood docs exist | Market claims must cite the exact benchmark file and caveats |
| Package hygiene | Build excludes compiled tests from dist | Keep `npm pack --dry-run` clean before publishing |

## MVP install surface

- Claude Code: `CLAUDE.md`, `.claude/skills/gps/SKILL.md`, `.claude/settings.json`, `.mcp.json`.
- Codex CLI: `AGENTS.md`, `.codex/config.toml` with `notify` and `mcp_servers.gps`.
- Cursor: `.cursor/rules/gps.mdc`, `.cursor/mcp.json`.
- Core MCP parity: `prepare_edit`, `get_context`, `tests_for`, `invariants_for`, `record_preference`, `record_directive`, `suggest`, and `brief`.
- Core CLI loop: `gps find`, `gps prepare --intent`, `gps brief`, `gps lessons record`, `gps inbox`, `gps promote --auto`.

## Auto memory suggestions

`--auto-suggest` is a feature flag, not an activation policy:

- It writes `auto_suggest: true` to `.gps/config.yml`.
- Claude Stop hooks run `gps suggest --auto`; that command is silent unless enabled and silent when there is nothing to suggest.
- MCP config uses `gps serve --observe` when enabled, recording only symbol names, counts, timestamps, and tool counts.
- CLI `gps prepare` traffic also feeds the authoring queue, so CLI-first usage works without MCP.
- Suggestions never write active memory and never promote invariants.

## Claims safe for launch

Use these because they map to committed evidence:

- **Graph brief vs ripgrep on Django:** `gps-brief` averaged 819 tokens at 85% recall vs ripgrep's 34,717 tokens at 56% recall. Source: `bench/perf/results/compare-django-2026-05-16.md`.
- **Dogfood quality:** in one internal repo, gps answers won 13 of 19 valid blinded comparisons, with overall quality 4.47 vs 4.03. Source: `bench/dogfood/2026-05-12-invariance-platform.md`.
- **Privacy line:** passive observation records symbol name, timestamp, and tool counts only. No prompt text, tool results, or conversation content.

Do not overclaim general productivity lift. The dogfood result is one repo and should stay framed that way.

## X thread hooks

1. Agents do not need a bigger context window for every task; they need the right repo memory before edits.
2. `gps prepare createRefund` returns callers, tests, invariants, notes, decisions, and recent changes in one brief.
3. The interesting part is not another code graph. It is author-defined invariants with evidence links, surfaced before the agent edits.
4. Memory capture is governed: `capture=inbox` queues suggestions for review, `capture=auto` preserves the fast path.
5. Auto memory suggestions are feature-flagged: `--auto-suggest` prints an authoring queue but never writes memory.
6. Works across Claude Code, Codex CLI, and Cursor using the same CLI/MCP backend.
7. Measured benchmark: on Django symbol briefs, 819 tokens at 85% recall vs ripgrep's 34,717 tokens at 56% recall.
8. Honest caveat: the end-to-end dogfood result is promising but small. The repo includes the methodology and raw numbers.

## Pre-publish checklist

```bash
pnpm gen:docs
pnpm gen:schemas
pnpm -r build
pnpm -r typecheck
pnpm -r test
pnpm release:check
(cd packages/cli && npm pack --dry-run)
```

Then test from a clean directory:

```bash
(cd packages/cli && npm pack)
npm install -g ./packages/cli/invariance-gps-0.1.0.tgz
mkdir /tmp/gps-smoke && cd /tmp/gps-smoke
git init
gps init
gps install claude --dry-run
gps --help
```

For the real release, use `scripts/release.ts` so all workspace packages stay lockstep.
