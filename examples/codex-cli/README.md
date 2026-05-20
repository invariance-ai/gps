# Using gps with Codex CLI

Codex CLI doesn't have pre-tool-use hooks like Claude Code, but it does support `notify` and MCP servers. gps registers both.

## Install

```bash
cd your-repo
npx -y @invariance/gps init
npx -y @invariance/gps install codex
npx -y @invariance/gps index
```

What gets written:

- `AGENTS.md` — appends a `<!-- gps:start -->...<!-- gps:end -->` block. Codex reads this on every session.
- `.codex/config.toml` — appends a `# gps:start ... # gps:end` block with:
  - `notify = ["npx", "-y", "@invariance/gps", "attach", "--transcript", "-"]` — turn-end transcript distillation
  - `[mcp_servers.gps]` registering `gps serve` as an MCP server

## Walkthrough

Open a Codex session in the repo. Try:

```
You: Walk me through what createRefund does and what tests cover it.
```

Codex will see the `AGENTS.md` block telling it to run `gps context` or call the `get_context` MCP tool before exploring. You should see it cite concrete line numbers and a test file in its first response.

After the edit:

```bash
gps lessons record "amount validation must happen before currency conversion"
```

The Codex `notify` hook fires `gps attach --transcript -` at turn end, distilling the conversation into Decision records anchored to the symbols touched.

## Verifying

```bash
gps serve   # confirms the MCP server starts cleanly; Ctrl-C to exit
gps validate --root "$PWD"
```

## What the installer writes

### AGENTS.md block

Same content as the Claude `CLAUDE.md` block — call patterns for `find`, `context`, `prepare`, `lessons record`, `decide`. See [`docs/guide/agents/codex.md`](../../docs/guide/agents/codex.md) for the full content.

### .codex/config.toml block

```toml
# gps:start — managed by `gps install codex`. Edit outside markers freely.
notify = ["npx", "-y", "@invariance/gps", "attach", "--transcript", "-"]

[mcp_servers.gps]
command = "npx"
args = ["-y", "@invariance/gps", "serve"]
# gps:end
```

`# gps:start` / `# gps:end` markers mean re-running `gps install codex` replaces the managed block without touching anything outside it.

## Uninstall

Remove the `# gps:start ... # gps:end` block from `.codex/config.toml` and the `<!-- gps:start -->...<!-- gps:end -->` block from `AGENTS.md`.
