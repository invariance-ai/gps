# Contributing to gps

Thanks for your interest in improving gps. This is a TypeScript pnpm monorepo; the dev loop is small.

## Prerequisites

- Node.js >= 20
- pnpm 10 (`corepack enable` will pick up the pinned version)

## Setup

```bash
git clone https://github.com/invariance-ai/gps.git
cd gps
pnpm install
pnpm -r build
```

## The gates (run before every PR)

These are exactly what CI runs:

```bash
pnpm -r build       # compile every package
pnpm -r typecheck   # tsc --noEmit across the workspace
pnpm -r test        # vitest
```

Run a single package's tests while iterating:

```bash
pnpm --filter @invariance/gps test          # the CLI
pnpm --filter @invariance/gps-core test      # the engine
```

If you change anything in `packages/schemas/src`, regenerate the committed artifacts and include them in your commit:

```bash
pnpm gen:schemas    # packages/schemas/json/*
pnpm gen:docs       # docs/guide/commands.md
```

## Dogfooding

gps develops itself: the repo has a `.gps/` instance. After a code change, `pnpm -r build` then point a checkout at the local CLI with `gps install claude --use-local` to try it live.

## Packages

| Package | What it is |
|---|---|
| `@invariance/gps` | the CLI (`packages/cli`) |
| `@invariance/gps-core` | symbol graph + memory engine (`packages/core`) |
| `@invariance/gps-mcp` | MCP stdio server (`packages/mcp`) |
| `@invariance/gps-llm` | thin Anthropic wrapper for distillation (`packages/llm`) |
| `@invariance/gps-schemas` | shared zod + JSON schemas (`packages/schemas`) |

## Pull requests

- Branch off `main`; keep PRs focused.
- Add or update vitest coverage for behavior changes.
- Make sure the three gates above are green.
- Use clear, present-tense commit messages (e.g. `fix(parser): …`, `feat(cli): …`).

## Releases (maintainers)

Versions are kept in lockstep across all published packages.

```bash
pnpm tsx scripts/release.ts <version>   # bump all packages, build, commit, tag
git push --follow-tags                  # publish.yml publishes to npm on the v* tag
```

`pnpm tsx scripts/release.ts --check` verifies lockstep without making changes.

## Reporting bugs / ideas

Open an issue: https://github.com/invariance-ai/gps/issues
