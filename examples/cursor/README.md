# Using gps with Cursor

Cursor agents have shell access and read project rules from `.cursor/rules/*.mdc`. gps installs an always-attached rule plus an MCP server entry.

## Install

```bash
cd your-repo
npx -y @invariance/gps init
npx -y @invariance/gps install cursor
npx -y @invariance/gps index
```

What gets written:

- `.cursor/rules/gps.mdc` — Cursor project rule with `alwaysApply: true`. Attached to every request.
- `.cursor/mcp.json` — adds `gps` to `mcpServers`. Existing entries are preserved (the file is JSON-merged).

## Walkthrough

In Cursor, open the agent chat and ask:

```
You: How do I add a $5000 cap to createRefund for non-enterprise customers?
```

Cursor will see the always-attached rule explaining that `gps prepare <symbol> --intent "<…>"` returns a decision-ready brief. Two surfaces are available — pick whichever fits the moment:

- **CLI**: `gps prepare createRefund --intent "add $5000 cap for non-enterprise"`
- **MCP**: call the `prepare_edit` tool with `{symbol: "createRefund", intent: "..."}`

The output includes structural context, tests, invariants, and notes from previous edits — before Cursor reads any file.

After the edit:

```bash
gps lessons record "non-enterprise caps live in pricing-config, not refunds"
```

## What the installer writes

### .cursor/rules/gps.mdc

```markdown
---
description: gps — local repo memory (symbol graph, tests, invariants, lessons, decisions). Use the CLI before non-trivial edits.
alwaysApply: true
---

# gps

<full agent instructions — see docs/guide/agents/cursor.md>
```

### .cursor/mcp.json

```json
{
  "mcpServers": {
    "gps": {
      "command": "npx",
      "args": ["-y", "@invariance/gps", "serve"]
    }
  }
}
```

If you already have other MCP servers in this file, they're preserved.

## Verifying

1. Cursor → Settings → MCP. The `gps` server should show a green dot.
2. Start a new chat. Ask about a real symbol. Cursor should run `gps prepare` or call `prepare_edit` before exploring.
3. If neither happens: Cursor sometimes caches rules — toggle the rule off and back on in Settings → Rules.

## Uninstall

Delete `.cursor/rules/gps.mdc` and remove the `gps` key from `mcpServers` in `.cursor/mcp.json`.
