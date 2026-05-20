# Dogfood runbook

How to measure gps's effect on a real repo, end-to-end. Follow this if you want to contribute a new datapoint, or reproduce the 2026-05-12 invariance-platform run.

The first run lives at [`bench/dogfood/2026-05-12-invariance-platform.md`](../bench/dogfood/2026-05-12-invariance-platform.md). The shape of every subsequent run should match it so results stack cleanly.

## What we measure

Per prompt: input tokens (raw + cache_creation + cache_read), output tokens, and a blinded judge score (correctness, specificity, completeness on a 1–5 scale). Aggregate to overall mean + win count across the prompt set.

The honest aggregate from run #1: tokens roughly flat (+1.4% input), quality +11%, judge wins 13 of 19. We expect this shape to hold — but until we have ≥3 runs across language families, it's n=1.

## Target-repo criteria

A useful target has:

- **Real complexity:** ≥200 source files, ≥1000 symbols, real test suite. Otherwise the prompt set is artificial.
- **Subsystem variety:** at least 3 distinguishable subsystems so prompts can hit different parts of the graph.
- **Open access:** public repo, MIT/Apache/BSD-style license. We won't publish results against private code.
- **Language coverage:** rotate TS, Python, mixed/monorepo so we exercise different parser paths.

### Next 3 targets

1. **A medium TS open-source backend** (e.g., a Hono / Fastify SaaS template, ~300–500 files). Stresses the TS parser on real production patterns.
2. **A medium Python project** — a FastAPI app or a data pipeline (~200–400 files). Stresses the Python parser branch and decorator-heavy code.
3. **A small monorepo** — pnpm workspaces with 3+ packages. Stresses cross-package call edges, which are currently the parser's weakest spot.

Open a GitHub issue tagged `dogfood-target` proposing a specific repo + SHA before you run.

## Prompt-set design

10 prompts per target. Balanced across:

- 3× **"where is X?"** — locating a feature, a config path, a side-effect.
- 3× **"how does X work?"** — explaining a subsystem at the right level of abstraction.
- 2× **"what tests cover Y?"** — surfacing the test contract for a symbol.
- 2× **"what would break if I changed X?"** — impact / blast-radius questions.

Prompts must be answerable from the code alone (no external runtime context required), and the judge prompt must score against the actual repo state.

## Procedure

```bash
# 1. Two fresh clones of the target at the same SHA.
git clone <target> baseline && (cd baseline && git checkout <SHA>)
git clone <target> gps     && (cd gps     && git checkout <SHA>)

# 2. Install gps into the gps/ clone only.
# Until @invariance/gps is on npm, use a local checkout's built CLI via --use-local
# (or omit the flag — install auto-detects workspace checkouts and switches to
# local mode automatically). Once published, drop the prefix and use `npx -y`.
cd gps
GPS_BIN="node /abs/path/to/gps-repo/packages/cli/dist/index.js"
$GPS_BIN init
$GPS_BIN install claude --use-local
$GPS_BIN index

# 3. Run each prompt against each clone with claude -p.
for p in prompts/*.txt; do
  for variant in baseline gps; do
    (cd $variant && claude -p "$(cat ../$p)" \
       --output-format json \
       --permission-mode bypassPermissions \
       --setting-sources user,project,local) \
      > out/$variant.$(basename $p .txt).json
  done
done

# 4. Judge from a neutral cwd with no repo context, blinded A/B, swapped order.
#    Use Sonnet 4.6. Score correctness, specificity, completeness 1–5.

# 5. Aggregate: per-prompt token delta, per-prompt judge mean, overall wins/losses/ties.
```

Tokens come from `usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}` in the claude JSON.

## Reporting

Drop a markdown file in `bench/dogfood/YYYY-MM-DD-<repo-slug>.md` matching the shape of [`bench/dogfood/2026-05-12-invariance-platform.md`](../bench/dogfood/2026-05-12-invariance-platform.md):

- Setup table (repo, SHA, size, index time, model, judge, prompts, variants).
- Per-prompt results table (tokens baseline, tokens gps, Δ, %, judge baseline, judge gps, winner).
- Aggregates section (input total, output total, judge means by dimension, win/loss/tie counts).
- Honest takeaway paragraph — what shape did this run reproduce, what changed.

Don't commit raw artifacts (claude JSON, judge transcripts) — they're large and often contain absolute paths. Methodology must be reproducible from the markdown alone.

## Contributing a result

File a GitHub issue using the `dogfood-result` template (see `.github/ISSUE_TEMPLATE/`). The team will replicate before merging the markdown to `bench/dogfood/`.

We will not publish marketing claims past the n=1 win rate (13/19) until at least two additional independent runs exist.
