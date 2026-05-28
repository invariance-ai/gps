# Security and privacy

`gps` is local-first repo memory for coding agents. Its launch default is designed
to be inspectable: memory lives in `.gps/`, agent instructions live in the native
files those agents already read, and MCP runs as a local stdio server.

## What gps stores

By default, gps may write these repo-local files:

- `.gps/config.yml` — repo policy such as capture mode, promotion mode, and
  experimental feature flags.
- `.gps/index/` — symbol graph and search index generated from local source.
- `.gps/invariants.yml` — human-authored repo rules with optional evidence.
- `.gps/notes/`, `.gps/decisions/`, `.gps/preferences.yml`, `.gps/inbox.yml` —
  durable memory captured manually or through agent integrations.
- `.gps/observations.json` — only when observation is enabled. Stores metadata
  such as symbol name, timestamp, and tool counts.

Do not put secrets in gps memory. Treat `.gps/` like code: review it in PRs,
delete stale entries, and use `capture=inbox` when a team wants approval before
captured memory becomes active.

## What gps does not store by default

The default CLI/MCP workflow does not send source code, prompts, tool results, or
conversation transcripts to a remote service.

Some optional commands can process transcripts or call an LLM if you explicitly
configure an API key and run those commands. Those commands write extracted
memory back to `.gps/` according to the repo capture policy.

## Agent integrations

`gps setup` can write integration files for the agent you choose:

- Claude Code: `CLAUDE.md`, `.claude/skills/gps/SKILL.md`,
  `.claude/settings.json`, `.mcp.json`.
- Codex CLI: `AGENTS.md`, `.codex/config.toml`.
- Cursor: `.cursor/rules/gps.mdc`, `.cursor/mcp.json`.

Claude hooks run local shell commands at session/tool/turn boundaries. Codex uses
MCP plus a `notify` command. Cursor uses an always-attached rule and MCP. Review
the generated files before committing them if your repo has strict automation
rules.

## Observation mode

Observation is off unless enabled through `--auto-suggest` or direct MCP server
flags. When enabled, gps records metadata needed for authoring suggestions:

- symbol name
- timestamp
- count-like tool metadata

It does not record prompt text, tool arguments, tool results, or generated code.
Suggestions never write active memory by themselves.

## Recommended team setup

For conservative teams:

```bash
npx -y @invariance/gps setup --yes --with-claude --capture=inbox
```

Then review captured memory with:

```bash
gps inbox
gps inbox approve <id>
gps inbox reject <id>
```

Use `capture=auto` for fast local/personal workflows where immediate activation
is acceptable.

## Disabling gps

To stop agent automation, remove the generated integration files for your agent:

- Claude Code: remove the gps-managed block from `CLAUDE.md`, delete
  `.claude/skills/gps/SKILL.md`, remove gps hooks from `.claude/settings.json`,
  and remove the gps MCP entry from `.mcp.json`.
- Codex CLI: remove the gps-managed block from `AGENTS.md` and the gps-managed
  block from `.codex/config.toml`.
- Cursor: delete `.cursor/rules/gps.mdc` and remove the gps server from
  `.cursor/mcp.json`.

To keep the integration but disable automatic suggestions, set
`auto_suggest: false` in `.gps/config.yml`.

## Reporting vulnerabilities

Please report security issues privately through the maintainer contact listed in
the repository profile, or open a minimal GitHub issue if no private route is
available. Do not include secrets or private code in public reports.
