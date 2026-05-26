# Claude Code

```bash
npx -y @invariance/gps install claude
```

Writes:

- `CLAUDE.md` — appends a `<!-- gps:start -->...<!-- gps:end -->` block with manual call instructions and standing-rules guidance. Idempotent: re-runs replace the block.
- `.claude/skills/gps/SKILL.md` — the gps skill. Claude Code auto-loads it.
- `.claude/settings.json` — five non-blocking hooks. See below.
- `.mcp.json` — registers the `gps` MCP server (`gps serve`). Merged with any existing `mcpServers` entries. This is what makes the `mcp__gps__prepare_edit` tool callable.

## The five hooks

| Hook | When | What it does |
|---|---|---|
| `SessionStart` (startup\|resume) | Session opens | `gps index` (rebuild graph), `gps feature clear-active`, `gps session start`, print `gps preferences --markdown` |
| `UserPromptSubmit` | Every prompt | `gps capture-preference --emit` (catches "from now on…" rules), `gps context-from-prompt` (auto-inject context for named symbols) |
| `PreToolUse` Edit\|MultiEdit\|Write | Before any edit | `gps index` — keep graph fresh |
| `PostToolUse` Bash | After every Bash | If exit code ≠ 0, `gps record-failure --kind bash` against the last-prepared symbol |
| `Stop` | Turn end | `gps attach --hook-stdin` (distill the session transcript into Decisions/Questions — auto-persists with an API key, else stashes a prompt under `.gps/pending-distill/`), `gps feature attribute --git-diff` (only if `gps validate` passes — stale graphs poison attribution), `gps session end` |

All hooks pipe to `>/dev/null 2>&1 || true`. A broken hook never breaks the agent.

`gps install claude --auto-suggest` also lets the Stop hook run `gps suggest --auto`. That command is silent unless `.gps/config.yml` has `auto_suggest: true`, and it only prints suggestions; it does not approve, promote, or write memory.

## What Claude does with gps

The injected `CLAUDE.md` block teaches Claude:

- Run `gps find` before writing a new helper.
- Run `gps context <symbol> --markdown` to plan a multi-file change.
- Run `gps decisions <symbol>` to check prior choices before re-litigating.
- Treat `gps preferences` output as soft constraints.
- Tag the session early with `gps feature use <label>`.
- Persist lessons with `gps lessons record` and decisions with `gps decide`.

## Verifying it's working

```bash
gps validate --root "$PWD"
```

Then in a Claude Code session:

```
You: What does createRefund do?
```

You should see Claude reference concrete line numbers and tests in its first response — that's `context-from-prompt` injecting the symbol's strands before Claude reads any files.

## Customizing

- **Skip the CLAUDE.md append**: `gps install claude --skip-claude-md`.
- **Use global binary instead of npx**: `npm install -g @invariance/gps && gps install claude --use-global`.
- **Force overwrite of managed files**: `gps install claude --force`.

## Uninstalling

Delete the `.claude/skills/gps/` directory, remove the `<!-- gps:start -->...<!-- gps:end -->` block from `CLAUDE.md`, clear `hooks` from `.claude/settings.json`, and remove the `gps` key from `mcpServers` in `.mcp.json`.
