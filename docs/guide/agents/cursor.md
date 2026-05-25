# Cursor

gps gives Cursor durable, symbol-anchored repo memory. Because Cursor has no lifecycle hooks, the agent must call `record_preference` and `record_directive` MCP tools explicitly — the installed rule instructs the agent to do this automatically.

```bash
npx -y @invariance/gps install cursor
```

Writes:

- `.cursor/rules/gps.mdc` — Cursor project rule with `alwaysApply: true`. Attached to every request without the agent having to discover it.
- `.cursor/mcp.json` — registers `gps serve` as an MCP server. Merged with any existing entries you already have.

## What Cursor does with gps

The rule frontmatter:

```markdown
---
description: gps — local repo memory (symbol graph, tests, invariants, lessons, decisions). Use the CLI before non-trivial edits.
alwaysApply: true
---
```

The body teaches the agent the standard gps calls and explains that Cursor has shell access — `gps` is a CLI, not a service. The MCP server in `.cursor/mcp.json` exposes the same surface as a tool set; the agent picks whichever fits.

Cursor doesn't expose pre/post-tool-use hooks. Index refresh happens lazily when `gps prepare` or `gps context` runs.

## Explicit preference and directive capture (Cursor-specific)

Claude Code and Codex capture preferences and directives automatically via hooks. Cursor has no hooks, so the installed rule instructs the agent to call these MCP tools explicitly:

**When the user gives a durable instruction** ("from now on…", "always…", "i prefer…", "don't ever…") — call `record_preference`:

```text
record_preference { "text": "<the user's instruction>" }
```

**When the user gives a location-scoped instruction** ("don't do X here", "always Y in this folder", "in the home page, avoid Z") — call `record_directive`:

```text
record_directive { "text": "<instruction>", "area": "<directory or alias>" }
```

gps stores preferences in a managed block (global scope) and directives as area-scoped notes that resurface whenever you edit files in that directory. The installed `.cursor/rules/gps.mdc` reminds the agent to make these calls — no manual setup is needed beyond running `gps install cursor`.

## Verifying it's working

1. In Cursor: Settings → MCP. The `gps` server should show as connected (green dot).
2. Start a new chat in the repo. Ask: *"What does `<some-symbol>` do?"*. The agent should run `gps prepare` or call the `prepare_edit` MCP tool before answering.
3. If the rule isn't being applied: check `.cursor/rules/gps.mdc` exists and has `alwaysApply: true` in the frontmatter.

## Customizing

- **Skip the MCP entry** (rule file only): `gps install cursor --skip-mcp`.
- **Use global binary**: `gps install cursor --use-global`.
- **Force overwrite**: `gps install cursor --force`.

## Uninstalling

Delete `.cursor/rules/gps.mdc` and remove the `gps` key from `mcpServers` in `.cursor/mcp.json`.
