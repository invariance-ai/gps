# Troubleshooting

## Hooks aren't firing (Claude Code)

```bash
gps validate --root "$PWD"     # checks .claude/settings.json + index
```

If `validate` is happy but hooks still don't fire:

1. Confirm `.claude/settings.json` exists and contains `hooks.UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`.
2. Make sure Claude Code is reading project settings (`--setting-sources user,project,local`).
3. Run a hook manually: `npx -y @invariance/gps context-from-prompt --root "$PWD"`. If it errors here, the hook will silently no-op in Claude.

## Symbol not found

```bash
gps find "<keyword>" --json | head -20
```

The regex parser misses some patterns. Known gaps:

- **TypeScript class methods on default-exported classes** — sometimes attributed to the file, not the class.
- **Python decorators that wrap functions** — the wrapped function is indexed; the decorator is not.
- **Re-exports** (`export * from`) — followed one level only.

Tree-sitter and LSP-backed resolution are on the roadmap (see `docs/design-alternatives.md`). For now: name the symbol by its definition site, not its re-export name.

## "Cannot find module '@invariance/gps-core'"

You're in a fresh checkout with `node_modules` but no built packages.

```bash
pnpm install
pnpm -r build
```

The `gps` CLI consumes the built `dist/` from sibling workspace packages.

## MCP server won't connect (Codex / Cursor)

- **Codex:** check `.codex/config.toml` has the `[mcp_servers.gps]` block. The Codex CLI sometimes silently drops MCP servers if their command exits non-zero; run `gps serve` standalone to confirm it starts.
- **Cursor:** check `.cursor/mcp.json`. Cursor reloads MCP servers on file save — toggle off/on in Settings → MCP after editing.

## Lesson classified to the wrong scope

```bash
gps lessons list --json | head     # find the id
gps lessons reclassify <id> --to global    # or symbol / file / feature
```

The classifier learns from `--hint-scope` corrections; if you find yourself reclassifying the same shape of lesson, file a note: `gps learn gps.lessons --lesson "classifier misses pattern X"`.

## Hooks slow down sessions

The `PreToolUse` Edit/Write hook runs `gps index`, which is incremental but can take a few hundred ms on large repos. To diagnose:

```bash
time gps index --root "$PWD"
```

If it's over a second consistently, narrow `config.yml` `exclude:` to skip generated/vendored directories.

## Observations file growing fast

`gps serve --observe` writes symbol query metadata to `.gps/observations.json` on every tool call. Add `.gps/observations.json` to `.gitignore` if your repo tracks `.gps/`, and delete the file occasionally if it gets noisy; it rebuilds from future observations.

## Where to file issues

- GitHub: <https://github.com/invariance-ai/gps/issues>
- Include `gps --version`, `gps validate --root "$PWD" --json`, and the exact command that failed.
