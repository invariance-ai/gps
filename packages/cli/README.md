# @invariance/gps

**A plug-in memory layer for your coding agents.** One install gives Claude Code, Codex, and Cursor durable, automatic, symbol-anchored repo memory — notes, decisions, preferences, and invariants captured by lifecycle hooks and surfaced only when the relevant code is touched. Unlike ephemeral todos or manually maintained CLAUDE.md files, gps memory persists across sessions, is anchored to specific symbols, and works identically across all three agents.

## Quickstart

```bash
cd your-repo
npx -y @invariance/gps setup --yes --with-claude      # or --with-codex / --with-cursor
```

That's it. `setup` initializes `.gps/`, builds the first symbol graph, lifts TODO/FIXME comments into notes, and wires the selected agent.

Full install with all options:

```bash
npx -y @invariance/gps setup --yes --with-claude
npx -y @invariance/gps setup --yes --with-codex
npx -y @invariance/gps setup --yes --with-cursor
npx -y @invariance/gps setup --yes --with-claude --with-codex --with-cursor
```

Governance flags:

```bash
gps install claude --capture=inbox         # review captured memory before it activates
gps install claude --promote=safe          # auto-promote recurring safe lessons
gps install claude --auto-suggest          # hook-safe authoring queue nudges; never writes memory
```

## Happy path

```bash
gps setup --yes --with-claude                         # init + index + TODO lift + Claude wiring
gps next                                              # first useful commands and sample prepare targets
gps prepare <symbol> --intent "<one-liner>"           # decision-ready brief before edits
gps remember "<one sentence>"                         # save hard-won repo facts
gps save-this "<one sentence>"                        # preview a save command; add --yes to persist
gps done                                              # post-edit self-audit + memory nudges
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
gps save-this "..."                                   # preview "save this?" capture
gps lessons record "..."                              # record a lesson; auto-classified global/scoped
gps notes <symbol>                                    # what previous edits left behind
gps learn-todos                                       # one-shot: lift TODO/FIXME into notes
gps decide <symbol> --decision "..." [--rejected "..."] [--rationale "..."]
gps decisions <symbol>                                # choices recorded, with rejected alternatives

# Server (MCP)
gps serve                                             # MCP stdio server
gps serve --observe                                   # opt-in: record per-symbol query counts only
gps suggest                                           # hot symbols, near-promotions, wasted-search memory nudges
gps suggest --auto                                    # no-op unless auto_suggest=true
gps review-memory --html                              # local visual memory review
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
