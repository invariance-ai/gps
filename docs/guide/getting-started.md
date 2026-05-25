# Getting started

gps is a plug-in memory layer for your coding agents. One install gives Claude Code, Codex, and Cursor durable, automatic, symbol-anchored repo memory — notes, decisions, preferences, and invariants captured by lifecycle hooks and surfaced only when the relevant code is touched.

A 10-minute walkthrough: install gps in a real repo, see it surface memory to an agent, then teach it something that sticks.

## 1. Install (1 min)

```bash
cd your-repo
npx -y @invariance/gps init
npx -y @invariance/gps install claude      # or `codex`, or `cursor`
npx -y @invariance/gps index
```

What just happened:

- `init` wrote `.gps/config.yml` (what to index) and `.gps/invariants.yml` (an example invariant you can delete).
- `install claude` wrote a `CLAUDE.md` block, a `.claude/skills/gps/SKILL.md` skill, five non-blocking hooks in `.claude/settings.json`, and a `gps` entry in `.mcp.json` (registers the gps MCP server).
- `index` built the symbol graph at `.gps/index.json`. Re-runs are incremental.

By default capture is **live** (`--capture=auto`) and nothing auto-graduates into invariants (`--promote=never`). To review captured memory before it activates, install with `--capture=inbox` and approve items via `gps inbox`. To let recurring lessons auto-graduate into invariants, add `--promote=safe` (holds back risky topics) or `--promote=all` (everything — bypasses the risk gate). Both persist to `.gps/config.yml`. See the [Capture & promotion policy](../../README.md#capture--promotion-policy) section in the README.

If you prefer a global install: `npm install -g @invariance/gps`, then add `--use-global` to the install commands so hooks call `gps` directly instead of `npx`.

If you're running gps from a local checkout (pre-publish, dogfood, or contributor dev), use `--use-local` so hooks point at the absolute path of your built CLI (`node /abs/path/to/packages/cli/dist/index.js`). The installer auto-detects this and switches to local mode when it sees it's running from a workspace checkout — set `CI=1` to force npx instead.

## 2. Look around (2 min)

```bash
gps find "<keyword>"             # fuzzy symbol search
gps context <symbol>             # multi-strand context (structure, tests, provenance, invariants)
gps impact <symbol>              # callers and blast radius
gps tests <symbol>               # tests that protect this symbol
```

Pick a real symbol from your repo and try each one. Every command accepts `--json` (machine-readable) or `--markdown` (LLM-readable).

In Claude Code the same surface is also exposed as MCP tools — `mcp__gps__prepare_edit` returns a decision-ready brief in one structured call and is the preferred entry point for agents over fanning out to Glob/Read/Grep.

## 3. Ask an agent something (3 min)

Open Claude Code in the repo and ask a question that mentions a symbol by name — for example:

> What does `createRefund` do, and what tests cover it?

The `UserPromptSubmit` hook fires `gps context-from-prompt`, which detects `createRefund` and injects its context strand before Claude reads any files. You should see Claude cite concrete line numbers and tests instead of grepping around.

## 4. Teach gps something (3 min)

After a real edit, persist what you learned:

```bash
gps lessons record "Wrap stripe.refunds.create in withRetry — flaky on Mondays"
```

gps auto-classifies the lesson:

- **global** lessons land in the `<!-- gps:global-lessons -->` block of `CLAUDE.md` (always loaded)
- **symbol-scoped** lessons land in `.gps/notes/symbol/<name>.json` (loaded only when that symbol is in context)

Wrong classification? `gps lessons reclassify <id> --to global`.

For invariants that should *block* future edits (e.g. policy rules), hand-edit `.gps/invariants.yml`:

```yaml
- name: High-value refunds require approval
  applies_to: [createRefund, "stripe.refunds.create"]
  rule: Refunds over 1000 require finance_approval_id.
  evidence: [docs/refund-policy.md]
  severity: block
```

Now the next time an agent runs `gps prepare createRefund`, this rule is in front of it.

## 5. See what agents are confused about (1 min)

```bash
gps serve --observe              # in a separate terminal, while an agent runs
gps suggest                      # symbols queried often with no covering invariant
```

`gps suggest` is your authoring queue — the symbols where the next invariant or note will have the most leverage.

## Next steps

- [`commands.md`](commands.md) — full CLI reference
- [`concepts.md`](concepts.md) — what symbols, strands, lessons, decisions, and preferences are
- [`files.md`](files.md) — what lives in `.gps/`
- [`agents/claude.md`](agents/claude.md), [`agents/codex.md`](agents/codex.md), [`agents/cursor.md`](agents/cursor.md) — per-IDE details
- [`troubleshooting.md`](troubleshooting.md) — common failures
