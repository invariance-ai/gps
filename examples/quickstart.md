# gps quickstart — the 30-second loop

Four commands. That's the entire OSS pitch.

```bash
npx @invariance/gps init --seed          # 1. set up + mine TODOs/commits/PRs into candidate notes
npx @invariance/gps index                # 2. build the symbol graph (tree-sitter, TS/JS/Python)
npx @invariance/gps prepare --intent "<what you plan to do>"
                                         # 3. decision-ready brief — invariants, callers, tests, prior decisions
# edit with Claude Code / Codex / Cursor / your hands
npx @invariance/gps brief                # 4. pre-finalize: changed symbols + invariants + notes + tests + "no tests" warnings
```

`prepare --intent` infers the symbol from natural language. You don't need to know the exact function name first.

`brief` returns exit code 1 only when a blocking invariant is hit. Untested changes are flagged but never fail.

## What you should see

After `init --seed`, gps writes `.gps/candidates/seed-*.yml` with mined notes and prints the top 3:

```
wrote   .gps/config.yml
wrote   .gps/invariants.yml
mining seed candidates (tier=safe)…
wrote   .gps/candidates/seed-2026-05-16T18-49-12-441Z.yml  (12 candidates)

Top 3 sample (by confidence):
  note (todo, conf 0.60) — refund flow needs idempotency key — see docs/refunds.md
  note (todo, conf 0.60) — TODO(createCharge): retry on 429
  note (todo, conf 0.60) — FIXME(parseAmount): handle empty string

note: candidates are written to .gps/candidates/ for manual review — they are NOT auto-promoted.
Next: open .gps/candidates/seed-*.yml to review, then run `gps seed --apply` to promote into .gps/notes and .gps/decisions.
```

After `index`:

```
scanning 247 files…                                        indexed 1834 symbols, 1102 edges across 247 files in 412ms
```

After `prepare --intent "add caching to refunds"`:

```
inferred symbol "createRefund" (confidence 92, via name-match) from intent
other candidates: refundService.process (78), refundCache (65)

# Brief for createRefund
… (invariants, callers, tests, decisions, notes) …

_picked symbol via_ `name-match` (score 92)

→ Run `gps brief` after editing to verify changed symbols, invariants, notes, and tests.
```

After editing `createRefund` and running `brief`:

```
# Brief — 1 symbol(s) across 2 file(s) vs HEAD

## Invariants
- **BLOCK** `refunds-require-approval` — Refunds over 1000 require finance_approval_id.
  - symbols: createRefund

## Notes
### symbol: `createRefund`
- (high) Always log the original charge id — _added 2025-11-04_

## Tests
- `createRefund` → `apps/api/refunds.test.ts`

⚠ 0 changed symbol(s) have no detected tests
✗ 1 blocking invariant violation(s) — resolve or waive before merge
```

## With Claude Code

```bash
npx @invariance/gps install claude       # writes .claude/skills/gps/SKILL.md + hooks + .mcp.json
                                          # use --dry-run first to preview writes
```

Hooks now fire automatically:
- **SessionStart**: rebuild index, print user preferences
- **UserPromptSubmit**: capture preferences/directives, auto-load context for symbols mentioned
- **PreToolUse (Edit/Write)**: keep index fresh
- **Stop**: run `gps brief` (non-blocking), attribute changes to the active feature

The skill teaches Claude the same 3-step loop: `gps find` → `gps prepare --intent` → `gps brief`.

## With Codex

```bash
npx @invariance/gps install codex        # appends to AGENTS.md + writes .codex/config.toml MCP entry
```

Codex has no shell hooks; `AGENTS.md` teaches it to run `gps prepare` before edits and `gps brief` after.

## With Cursor

```bash
npx @invariance/gps install cursor       # writes .cursor/rules/gps.mdc + .cursor/mcp.json
```

`.cursor/rules/gps.mdc` is `alwaysApply: true`, so every Cursor request sees the gps playbook.
