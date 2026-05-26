# @invariance/gps

**A plug-in memory layer for your coding agents.** One install gives Claude Code, Codex, and Cursor durable, automatic, symbol-anchored repo memory — notes, decisions, preferences, and invariants captured by lifecycle hooks and surfaced only when the relevant code is touched. Unlike ephemeral todos or manually maintained CLAUDE.md files, gps memory persists across sessions, is anchored to specific symbols, and works identically across all three agents.

## Quickstart

```bash
cd your-repo
npx -y @invariance/gps install claude      # or: install codex | install cursor
npx -y @invariance/gps index
```

That's it. Start a new agent session — the memory layer is active.

Full install with all options:

```bash
npx -y @invariance/gps init                # write .gps/config.yml + .gps/invariants.yml
npx -y @invariance/gps install claude      # wire CLAUDE.md + .claude skill/hooks + .mcp.json
npx -y @invariance/gps install codex       # wire AGENTS.md + .codex/config.toml (notify + MCP)
npx -y @invariance/gps install cursor      # write .cursor/rules/gps.mdc + .cursor/mcp.json
npx -y @invariance/gps index               # build the symbol graph
npx -y @invariance/gps learn-todos         # bootstrap notes from existing TODO/FIXME
```

Governance flags:

```bash
gps install claude --capture=inbox         # review captured memory before it activates
gps install claude --promote=safe          # auto-promote recurring safe lessons
gps install claude --auto-suggest          # hook-safe authoring queue nudges; never writes memory
```

## Core 5 commands

```bash
gps init                                              # 1. write config files
gps install claude                                    # 2. wire agent integration (or: codex | cursor)
gps index                                             # 3. build the symbol graph
gps prepare <symbol> --intent "<one-liner>"           # 4. decision-ready brief before edits
gps lessons record "<one sentence>"                   # 5. record what an edit taught you
```

## Full reference

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
gps notes <symbol>                                    # what previous edits left behind
gps learn-todos                                       # one-shot: lift TODO/FIXME into notes
gps decide <symbol> --decision "..." [--rejected "..."] [--rationale "..."]
gps decisions <symbol>                                # choices recorded, with rejected alternatives

# Server (MCP)
gps serve                                             # MCP stdio server
gps serve --observe                                   # opt-in: record per-symbol query counts only
gps suggest                                           # surface symbols agents touch with no invariant
gps suggest --auto                                    # no-op unless auto_suggest=true
```

All read commands accept `--json` (stable contract) or `--markdown` (LLM-optimal).

## Requirements

Node >= 20. No native deps — tree-sitter runs as WASM.

## Full documentation

[github.com/invariance-ai/gps](https://github.com/invariance-ai/gps)

- [Getting started (10-min walkthrough)](https://github.com/invariance-ai/gps/blob/main/docs/guide/getting-started.md)
- [Command reference](https://github.com/invariance-ai/gps/blob/main/docs/guide/commands.md)
- [Claude Code setup](https://github.com/invariance-ai/gps/blob/main/docs/guide/agents/claude.md)
- [Codex setup](https://github.com/invariance-ai/gps/blob/main/docs/guide/agents/codex.md)
- [Cursor setup](https://github.com/invariance-ai/gps/blob/main/docs/guide/agents/cursor.md)

## License

MIT. Built by [Invariance](https://invariance.ai).
