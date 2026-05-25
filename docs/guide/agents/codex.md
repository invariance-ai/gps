# Codex CLI

gps gives Codex durable, automatic, symbol-anchored repo memory. The `notify` hook captures preferences and directives from every turn — no manual calls needed.

```bash
npx -y @invariance/gps install codex
```

Writes:

- `AGENTS.md` — appends a `<!-- gps:start -->...<!-- gps:end -->` block. Codex reads this at session start.
- `.codex/config.toml` — appends a `# gps:start ... # gps:end` managed block with two entries:
  - `notify = ["npx", "-y", "@invariance/gps", "attach", "--transcript", "-"]` — turn-end hook that distills the transcript into Decisions **and** automatically captures preferences ("from now on…", "always…", "i prefer…") and location-scoped directives
  - `[mcp_servers.gps]` — registers `gps serve` as an MCP server

The `notify` hook is how Codex gets automatic preference and directive capture — it fires after every turn, reads the transcript via stdin, and persists any durable instructions into the gps memory layer. You do not need to call `record_preference` or `record_directive` manually in Codex; the hook handles this automatically.

The Codex CLI does not expose pre-tool-use hooks, so the index is refreshed lazily by `gps prepare` and `gps context` calls. Treat `gps` like `rg`: a local CLI Codex runs before non-trivial edits.

## What Codex does with gps

The `AGENTS.md` block teaches Codex the same calls as Claude:

```bash
gps find "<keyword>"
gps context <symbol> --markdown
gps prepare <symbol> --intent "<…>"
gps lessons record "<…>"
gps decide <symbol> --decision "<…>" --rejected "<…>"
```

The MCP server exposes the same surface as tools (see [`docs/guide/commands.md`](../commands.md) for the full list).

## Verifying it's working

Run `gps serve` standalone to confirm the MCP server starts cleanly:

```bash
gps serve
# (waits on stdio; Ctrl-C to exit)
```

If Codex's notify hook isn't firing, check that `notify` lives inside the top-level table of `.codex/config.toml` (not nested under a `[section]`). The installer writes it correctly; manual edits sometimes accidentally nest it.

## Customizing

- **Skip the AGENTS.md append**: `gps install codex --skip-agents-md`.
- **Use global binary**: `gps install codex --use-global`.
- **Force overwrite**: `gps install codex --force`.

## Uninstalling

Remove the `<!-- gps:start -->...<!-- gps:end -->` block from `AGENTS.md` and the `# gps:start ... # gps:end` block from `.codex/config.toml`.
