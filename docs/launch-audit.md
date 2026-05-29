# gps launch audit

This is the MVP bar for a launch that is genuinely useful rather than just a demo.

## MVP user promise

`gps` should make a coding agent better on day one by giving it the context humans normally repeat:

- what symbol to edit and where it lives
- callers, likely tests, and recent provenance before the edit
- product/engineering invariants with evidence links
- durable preferences and location-scoped directives
- a review path for captured memory before it becomes active

The default loop should stay boring:

```bash
npx -y @invariance/gps setup --yes --with-claude    # or --with-codex / --with-cursor
gps prepare <symbol> --intent "what I am about to change"
gps remember "hard-won repo fact"
gps done
```

## Launch-critical capabilities

| Area | Current status | Launch bar |
|---|---|---|
| npm install | Working package build and `npm pack --dry-run` for `@invariance/gps` | Publish all workspace packages in dependency order; verify packed install for Claude/Codex/Cursor and `npx -y @invariance/gps@latest --help` from a clean temp repo after publish |
| Claude Code | Skill, hooks, MCP server, CLAUDE.md block | `install claude --dry-run`, `install claude`, then verify `.claude/settings.json`, `.mcp.json`, and `CLAUDE.md` |
| Codex CLI | AGENTS.md, notify hook, MCP server | Verify `.codex/config.toml` has top-level `notify` and `mcp_servers.gps` |
| Cursor | Always-attached rule plus MCP server | Verify `.cursor/rules/gps.mdc` and `.cursor/mcp.json` |
| Memory governance | `capture=auto|inbox`, `promote=never|safe|all` | Default is useful-but-gated (`promote=safe`); recommend `--capture=inbox` for teams that need review |
| Auto suggestions | Feature flag: `auto_suggest=false` by default, enabled by `--auto-suggest` | Hook-safe `gps suggest --auto` must never write memory and must no-op unless enabled |
| Live docs | Experimental local HTML docs via `gps doc --experimental-live-docs` | Must stay explicitly feature-flagged; server binds localhost by default and must not be represented as stable launch surface |
| Benchmarks | Measured perf and dogfood docs exist | Market claims must cite the exact benchmark file and caveats |
| Package hygiene | Build excludes compiled tests from dist | Keep `npm pack --dry-run` clean before publishing |
| Help surface | Curated top-level commands | `gps --help` should show setup/prepare/remember/done/doc/find/doctor, while advanced commands remain callable |

## MVP install surface

- Claude Code: `CLAUDE.md`, `.claude/skills/gps/SKILL.md`, `.claude/settings.json`, `.mcp.json`.
- Codex CLI: `AGENTS.md`, `.codex/config.toml` with `notify` and `mcp_servers.gps`.
- Cursor: `.cursor/rules/gps.mdc`, `.cursor/mcp.json`.
- Core MCP parity: `prepare_edit`, `get_context`, `tests_for`, `invariants_for`, `record_preference`, `record_directive`, `suggest`, and `brief`.
- Core CLI loop: `gps find`, `gps prepare --intent`, `gps brief`, `gps lessons record`, `gps inbox`, `gps promote --auto`.

## Auto memory suggestions

`--auto-suggest` is a feature flag, not an activation policy:

- It writes `auto_suggest: true` to `.gps/config.yml`.
- Claude Stop hooks run `gps suggest --auto`; that command is silent unless enabled and silent when there is nothing to suggest.
- MCP config uses `gps serve --observe` when enabled, recording only symbol names, counts, timestamps, and tool counts.
- CLI `gps prepare` traffic also feeds the authoring queue, so CLI-first usage works without MCP.
- Suggestions never write active memory and never promote invariants.

## Experimental surfaces

Experimental features must be opt-in and labeled in CLI help, docs, and output:

- `gps doc --experimental-live-docs` writes `.gps/docs/live.html`.
- `gps doc --experimental-live-docs --serve` starts a localhost-only live view for browser panes in online IDEs.
- Persistent opt-in is `experimental.live_docs: true` in `.gps/config.yml`.
- Do not include experimental live docs in launch claims except as a clearly labeled preview.

## Claims safe for launch

Use these because they map to committed evidence:

- **Graph brief vs ripgrep on Django:** `gps-brief` averaged 819 tokens at 85% recall vs ripgrep's 34,717 tokens at 56% recall in the targeted symbol-brief benchmark. Source: `bench/perf/results/compare-django-2026-05-16.md`.
- **Dogfood quality:** in one internal repo, gps answers won 13 of 19 valid blinded comparisons, with overall quality 4.47 vs 4.03. Source: `bench/dogfood/2026-05-12-invariance-platform.md`.
- **Privacy line:** passive observation records symbol name, timestamp, and tool counts only. No prompt text, tool results, or conversation content.

Do not overclaim general productivity lift. The dogfood result is one repo and should stay framed that way. Do not lead Product Hunt with token savings; lead with repo memory, context quality, governed capture, and the correction-to-reuse loop.

## 60-second demo bar

The launch video should make the product obvious without explaining the whole command surface:

1. Run `gps prepare refundEndpoint --intent "return a typed error on overflow"` and show the brief.
2. Add the correction once: `gps remember "in apps/api, don't build error strings inline — use the errors module" --area apps/api`.
3. Run the same `gps prepare` again and show the directive under "Directives for this path".
4. Run `gps done` or `gps doc --base HEAD` to show review-time value.

If the viewer remembers only one sentence, it should be: "GPS helps coding agents remember the repo-specific lessons you already taught them."

## X thread hooks

1. Agents do not need a bigger context window for every task; they need the right repo memory before edits.
2. `gps prepare createRefund` returns callers, tests, invariants, notes, decisions, and recent changes in one brief.
3. `gps remember` turns a correction into durable memory; the next relevant edit sees it before touching code.
4. The interesting part is not another code graph. It is author-defined invariants and human corrections with evidence links, surfaced before the agent edits.
5. Memory capture is governed: `capture=inbox` queues suggestions for review, `capture=auto` preserves the fast path.
6. `gps doc` turns the current diff into a shareable review artifact with relevant GPS memory attached.
7. Works across Claude Code, Codex CLI, and Cursor using the same CLI/MCP backend.
8. Measured benchmark: on Django symbol briefs, 819 tokens at 85% recall vs ripgrep's 34,717 tokens at 56% recall.
9. Honest caveat: the end-to-end dogfood result is promising but small. The repo includes the methodology and raw numbers.

## Pre-publish checklist

```bash
pnpm gen:docs
pnpm gen:schemas
pnpm --filter @invariance/gps-schemas build
pnpm --filter @invariance/gps-core build
pnpm -r build
pnpm -r typecheck
pnpm -r test
pnpm smoke:pack
pnpm release:check
```

`pnpm smoke:pack` installs the packed workspace tarballs into clean temporary
repos and verifies Claude-only, Codex-only, Cursor-only, and all-agent setup.
After publishing, run one public-registry check so npm `latest` is not stale:

```bash
tmp="$(mktemp -d)"
git init -q "$tmp"
printf 'export function hello() { return "hi"; }\n' > "$tmp/hello.ts"
npx -y @invariance/gps@latest setup --yes --with-codex --root "$tmp"
npx -y @invariance/gps@latest doctor --json --root "$tmp"
test -f "$tmp/AGENTS.md"
test -f "$tmp/.codex/config.toml"
test ! -e "$tmp/CLAUDE.md"
```

When iterating on the doc/review feature specifically, use the narrow checks first:

```bash
pnpm --dir packages/core exec vitest run src/doc/doc_model.test.ts src/doc/render.test.ts src/doc/doc_store.test.ts src/doc/doc_annotations.test.ts src/doc/diff_split.test.ts src/doc/highlight.test.ts
pnpm --dir packages/llm exec vitest run src/doc_annotate.test.ts
pnpm --dir packages/cli exec vitest run src/commands/doc.test.ts
```

Then test from a clean directory:

```bash
pnpm smoke:pack
```

For the real release, use `scripts/release.ts` so all workspace packages stay lockstep.
