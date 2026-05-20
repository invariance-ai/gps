# Using gps with Claude Code

Use the CLI surface first. Claude Code is already good at shelling out; `gps`
should feel like `rg` for repo context and memory.

## Recommended — CLI + hooks (npx, no global install required)

```bash
cd your-repo
npx -y @invariance/gps init
npx -y @invariance/gps install claude
npx -y @invariance/gps index
```

This writes:

- `CLAUDE.md` instructions that tell Claude to run `gps` like `rg`
- `.claude/skills/gps/SKILL.md`
- `.claude/settings.json` with four non-blocking hooks (all using `npx -y @invariance/gps ...`):
  - `UserPromptSubmit` → `gps context-from-prompt` — auto-surfaces invariants/notes for symbols mentioned in the user's prompt
  - `PreToolUse` Edit/Write → `gps index` — keeps the symbol graph fresh
  - `PostToolUse` Bash → `gps record-failure` — captures non-zero exits against the last-prepared symbol
  - `Stop` → `gps attach --transcript -` — distills the session transcript into Decisions

Prefer the global `gps` binary in hooks? `npm install -g @invariance/gps` then add `--use-global` to the install command.

The hook keeps the local index fresh before edits. The skill/instructions teach
Claude when to run:

```bash
gps prepare <symbol> --intent "<one-line description>"
gps tests <symbol> --json
gps find "<keyword>" --json
gps learn <symbol> --lesson "<one sentence>" --severity <low|medium|high>
```

## Manual CLI instructions

If you do not want generated files, add this to `CLAUDE.md` yourself:

```text
You have access to `gps`, a CLI that returns structured repo context.

Before editing any non-trivial symbol, run:
  gps prepare <symbol> --intent "<one-line description>"

After a successful change that taught you something non-obvious, run:
  gps learn <symbol> --lesson "<one sentence>" --severity <low|medium|high>

To check what tests to run after editing:
  gps tests <symbol> --json
```

Same code path, no MCP server needed.

## What the installer writes

These are the generated files. You can tune them per repo.

### `.claude/skills/gps/SKILL.md`

```yaml
---
name: gps
description: Use gps to fetch repo context (symbols, callers, tests, invariants, lessons) before editing code, and to record lessons after.
---

# Using gps

When the user asks for a non-trivial edit to a symbol:

1. Run `gps prepare <symbol> --intent "<short>"` first. The output includes structure, tests, invariants, and notes from previous edits. **Respect any invariants marked `[block]`**.
2. Run the requested edit.
3. Run the tests listed under "Tests to run after editing".
4. If you discovered something non-obvious (a hidden caller, a subtle bug, a constraint), record it:
   `gps learn <symbol> --lesson "<one sentence>" --severity <low|medium|high>`

For broader change impact, use `gps impact <symbol>`. For finding existing helpers before adding new ones, use `gps find "<keyword>"`.
```

### `.claude/settings.json` (hooks)

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "npx -y @invariance/gps context-from-prompt --root \"$PWD\" 2>/dev/null || true" }] }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|MultiEdit|Write",
        "hooks": [{ "type": "command", "command": "npx -y @invariance/gps index --root \"$PWD\" >/dev/null 2>&1 || true" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "if [ \"${CLAUDE_TOOL_EXIT_CODE:-0}\" != \"0\" ]; then npx -y @invariance/gps record-failure --kind bash --message \"exit ${CLAUDE_TOOL_EXIT_CODE:-?}\" >/dev/null 2>&1 || true; fi" }]
      }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "npx -y @invariance/gps attach --transcript - >/dev/null 2>&1 || true" }] }
    ]
  }
}
```

The hooks are intentionally dumb shell commands — the gps CLI does all the work. `context-from-prompt` extracts symbol-like tokens from the prompt and surfaces invariants/notes only when there's a high-confidence index hit (otherwise silent). `record-failure` is a no-op if no symbol has been `gps prepare`d in the session.

## Native LLM use

Commands that need reasoning print prompts for Claude Code by default:

```bash
gps postmortem --pr 1287
gps attach --transcript session.txt
gps pr-intent --pr 1287
```

Claude answers using its native model/session; then you persist the result with
`gps learn`, `gps decide`, or by editing `.gps/invariants.yml`.

## Optional MCP

MCP is still available, but it is secondary to CLI+hooks:

```bash
claude mcp add gps -- gps serve
```
