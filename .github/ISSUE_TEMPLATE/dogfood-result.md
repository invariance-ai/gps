---
name: Dogfood result
about: Report a measured gps run against a real repo
title: "dogfood: <repo-slug> @ <short-sha>"
labels: ["dogfood-result"]
---

## Target

- Repo: `owner/name`
- SHA: `xxxxxxx`
- Size: <files> source files, <symbols> symbols, <edges> edges (per `gps index`)
- Language(s): TS / Python / mixed
- License: MIT / Apache / …

## Setup

- Model under test: Claude Opus 4.7 (1M ctx) via `claude -p --output-format json`
- Judge model: Claude Sonnet 4.6, blinded A/B, swapped order
- Prompts: <N> prompts (mix of where/how/tests/impact — see `docs/dogfood-runbook.md`)
- Variants: baseline (vanilla clone) vs gps (`init` + `install claude` + `index`)

## Headline numbers

| | baseline | gps |
|---|---:|---:|
| input tokens (total) | | |
| output tokens (total) | | |
| judge overall (1–5) | | |
| judge wins | | |

## Per-prompt table

Paste in the same shape as `bench/dogfood/2026-05-12-invariance-platform.md`.

## Takeaway

One paragraph. What did this run confirm or contradict from prior runs?

## Reproducibility

- Prompt set: (gist / file in PR)
- Judge prompt: (link)
- Procedure deviated from `docs/dogfood-runbook.md`? If so, where:

## Checklist

- [ ] Both clones at the same SHA
- [ ] gps installed only in the gps/ clone
- [ ] Judge run from neutral cwd with no repo context
- [ ] A/B order swapped between the two judge passes
- [ ] No raw claude JSON committed (size + PII)
