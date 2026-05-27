# Codex CLI

GPS gives Codex durable, symbol-anchored repo memory. Codex learns the workflow from `AGENTS.md`, gets structured tools through MCP, and uses the `notify` hook to capture durable preferences and directives after each turn.

```bash
npx -y @invariance/gps setup --yes --with-codex
```

Writes:

- `AGENTS.md` — appends a `<!-- gps:start -->...<!-- gps:end -->` block. Codex reads this at session start and learns when to run GPS.
- `.codex/config.toml` — appends a `# gps:start ... # gps:end` managed block with two entries:
  - `notify = ["npx", "-y", "@invariance/gps", "attach", "--transcript", "-"]` — turn-end hook that distills the transcript into Decisions **and** automatically captures preferences ("from now on…", "always…", "i prefer…") and location-scoped directives
  - `[mcp_servers.gps]` — registers `gps serve` as an MCP server

The `notify` hook is how Codex gets automatic preference and directive capture. It fires after every turn, reads the transcript via stdin, and persists durable instructions into the GPS memory layer according to your capture policy. You do not need to call `record_preference` or `record_directive` manually in Codex for normal "from now on" instructions; the hook handles that.

The Codex CLI does not expose pre-tool-use hooks, so the index is refreshed lazily by `gps prepare` and `gps context` calls. Treat `gps` like `rg`: a local CLI Codex runs before non-trivial edits.

Codex learns the workflow from `AGENTS.md`. The MCP block gives it tool access, and the notify hook captures what it should remember after each turn.

## What Codex does with gps

The `AGENTS.md` block teaches Codex this loop:

```bash
gps prepare --intent "<what I am about to change>"
gps prepare <symbol> --intent "<short intent>"
gps brief
gps remember "<hard-won repo fact>"
gps remember "<unfinished follow-up>" --reminder --symbol <symbol>
gps lessons record "<…>"
```

When MCP is available, Codex can call `prepare_edit`, `brief`, `get_context`, `tests_for`, `invariants_for`, `record_preference`, and `record_directive` as tools. The MCP tools and CLI commands read the same `.gps/` memory. Use whichever interface is more natural in the moment; the data is the same.

The practical behavior to expect:

- Before editing, Codex should run `gps prepare` or call `prepare_edit`.
- While working, Codex can save hard-won repo facts with `gps remember`, and unfinished follow-ups with `gps remember --reminder`.
- Before handing work back, Codex should run `gps brief`.
- After the turn, `notify` can capture durable user instructions like "always run this test twice" or "in this folder, use the errors module".

## Verifying it's working

Run `gps serve` standalone to confirm the MCP server starts cleanly:

```bash
gps serve
# (waits on stdio; Ctrl-C to exit)
```

Then start Codex in the repo and ask for a non-trivial change. You should see it either shell out to `gps prepare ...` or call the GPS MCP `prepare_edit` tool before editing.

If Codex's notify hook isn't firing, check that `notify` lives inside the top-level table of `.codex/config.toml` (not nested under a `[section]`). The installer writes it correctly; manual edits sometimes accidentally nest it.

## Customizing

- **Skip the AGENTS.md append**: `gps install codex --skip-agents-md`.
- **Use global binary**: `gps install codex --use-global`.
- **Force overwrite**: `gps install codex --force`.

## Uninstalling

Remove the `<!-- gps:start -->...<!-- gps:end -->` block from `AGENTS.md` and the `# gps:start ... # gps:end` block from `.codex/config.toml`.
