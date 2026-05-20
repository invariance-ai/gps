# GPS hooks for Claude Code

Drop `settings.json` into `.claude/settings.local.json` (project-local) or
`~/.claude/settings.json` (user-global) to turn GPS into an active edit guard:

- **PostToolUse** (after Edit / Write / MultiEdit): runs `gps gate --changed`.
  Maps the just-edited hunks to symbols, flags any invariant violations the
  agent introduced. JSON is read by the next tool call's context.
- **Stop**: runs `gps review-diff` as a final check before the agent signs off.
  Catches anything that slipped through.

Prerequisite: `gps` on `$PATH`, a built `.gps/index/`, and at least one
invariant in `.gps/invariants.yml`. Run `gps init` if you don't have these.

Pair with `gps gate --watch` in a separate terminal if you want a streaming
view: violations append to `.gps/cache/gate-stream.jsonl` and the agent can
poll them via the `gate_stream` MCP tool.
