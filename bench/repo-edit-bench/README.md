# repo-edit-bench

Measures whether `gps` reduces bad agent edits in real repos.

## Design

For each task in `tasks/`:

1. Run a coding agent (Claude Code, Codex, Cursor agent) twice:
   - **baseline** — normal tools only (grep, read, edit)
   - **gps** — same tools + `gps` MCP server (`get_context`, `impact_of`, `tests_for`, `invariants_for`)
2. Score the resulting patch on:
   - task success (functional check)
   - tests passed after edit
   - regressions introduced (broken unrelated tests)
   - unnecessary files touched
   - duplicated helper creation
   - relevant tests selected
   - tokens spent on repo exploration
   - time to first correct patch

## Task format

```yaml
# tasks/001-refund-cap.yml
repo: examples/refund-app
prompt: |
  Add a $5000 cap to refunds for non-enterprise customers.
checks:
  - "grep -q 'amount > 5000' apps/api/src/refunds.ts"
  - "pnpm test refund"
invariants_expected:
  - "High-value refunds require approval"
```

## Status

v0 harness lands in week 5 of the build plan. Tasks contributed via PR.
