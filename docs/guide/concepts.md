# Concepts

The shapes gps trades in. Six minutes to read.

## Symbol

The atomic unit. Functions, classes, methods, variables, types, and modules. Every symbol has a stable ID, a qualified name (`pkg.module.fn`), and a file:line location.

## Strands

Five threads attached to each symbol. gps composes them on demand:

| Strand | Source | Loaded when |
|---|---|---|
| **structural** | Parser (calls, callers, imports) | Always — the spine |
| **tests** | Test-file detection (vitest, jest, pytest, mocha) | When `gps tests` or `prepare` is called |
| **provenance** | `git log` over the symbol's range | When `gps trace` or `prepare` is called |
| **invariants** | `.gps/invariants.yml` matched by `applies_to` | When the symbol is the target of any read command |
| **notes** | `.gps/notes/{symbol,file,feature}/` | When the symbol is named |

## Lessons, notes, invariants, decisions

Four artifact types, one symbol anchor. Knowing which to use matters:

| Artifact | Shape | Authored by | Scope | Promotes to |
|---|---|---|---|---|
| **Lesson** | One sentence + severity | Agent or human via `gps lessons record` | Auto-classified: global → CLAUDE.md, scoped → notes | Invariant (after `gps promote`) |
| **Note** | Free text + evidence | Anyone (TODO/FIXME, agent, human) | Symbol / file / feature | Invariant |
| **Invariant** | Rule, applies_to, severity, evidence | PM or eng lead, by hand | Repo-wide via `applies_to` patterns | — |
| **Decision** | Choice + rejected alternative + rationale | Human or LLM-distilled from a session | Per symbol | — |

The mechanic: lessons and notes "deflate" over time. Recurring lessons get promoted to invariants (durable, rule-shaped). Once an invariant covers them, gps stops surfacing the notes — the invariant strand takes over.

## Preferences

Standing rules the user has given the agent (e.g. *"always use tabs in this repo"*, *"don't write tests for trivial getters"*). Captured automatically by the `capture-preference` hook when the user gives durable instructions in chat. Persisted to `.gps/preferences.json` and surfaced every session.

Preferences are soft constraints; invariants are hard ones.

## Scope tiers

For lessons, gps's auto-classifier picks one of four scopes based on the lesson text:

- **global** — repo-wide rule (lands in `CLAUDE.md` global-lessons block; always loaded)
- **feature** — applies to a tagged feature (loaded when that feature is active)
- **file** — applies to a file (loaded when the file is mentioned)
- **symbol** — applies to one symbol (loaded when the symbol is named)

Override with `--hint-scope <tier>` or after-the-fact with `gps lessons reclassify <id> --to <tier>`.

## Features

A short kebab-case label for the thing you're working on (e.g. `auth-flow`, `dashboard-charts`). Tag the session with `gps feature use auth-flow` and gps learns which symbols belong to that feature by attributing the symbols touched during the session. On future sessions that mention `auth-flow`, gps surfaces those symbols automatically.

## Authoring queue

`gps serve --observe` records (symbol, timestamp) tuples to `.gps/observations.json` — nothing else, no tool args, no conversation content. `gps suggest` reads those counts and surfaces the symbols agents touch a lot that have no covering invariant. The next thing worth writing.

## Compaction loop

The full lifecycle:

```
TODO/FIXME ─┐
agent edit ─┼─► lesson ─► note ─► (recurring) ─► invariant
human note ─┘
                              session ─► decision
```

Lessons compact into notes (scoped) or CLAUDE.md (global). Notes compact into invariants when patterns recur. Sessions compact into decisions. gps's job is to make each compaction step easy and to surface the right slice at edit time.
