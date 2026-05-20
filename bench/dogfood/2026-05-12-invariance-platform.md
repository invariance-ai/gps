# GPS dogfood — invariance-platform, 2026-05-12

End-to-end measurement of GPS against a real internal repo using `claude -p`. Goal: quantify the token-savings claim from the README, and check whether savings (if any) come at a quality cost.

## Setup

| | |
|---|---|
| Target repo | `invariance-ai/invariance-platform` @ `94e2281b` (origin/main) |
| Repo size | 309 source files, 1832 symbols, 1529 edges (per `gps index`) |
| Index time | 286 ms |
| Model under test | Claude Opus 4.7 (1M ctx) via `claude -p --output-format json` |
| Judge model | Claude Sonnet 4.6, blinded A/B, swapped order to remove positional bias |
| Prompts | 10 realistic developer questions about subsystems (traces, replay, auth, dashboard, deploy boundaries, etc.) |
| Variants | **baseline** = vanilla clone, no GPS; **gps** = same SHA with `gps init` + `gps install claude` + `gps index` |
| Per-prompt invocations | `claude -p "<question>" --output-format json --permission-mode bypassPermissions --setting-sources user,project,local` |

Both checkouts were fresh clones at the same SHA. Same model, same prompt text, same permission mode. The only difference: presence of GPS's `.claude/settings.json` hooks, `CLAUDE.md` block, and `.gps/` index.

## Per-prompt results

| # | Prompt (short) | base tok | gps tok | Δ | % | b qual | d qual | winner |
|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | trace capture & replay in apps/api | 145,563 | 179,139 | +33,576 | +23.1% | 3.83 | **4.67** | **gps** |
| 2 | Supabase auth in hospital-portal | 123,910 | 125,217 | +1,307 | +1.1% | 4.67 | 4.50 | tie |
| 3 | dashboard charts data flow | 145,310 | 125,638 | **−19,672** | **−13.5%** | 2.83 | **4.67** | **gps** |
| 4 | hospital-portal ↔ api contract | 126,466 | 125,155 | −1,311 | −1.0% | 4.50 | 4.17 | tie |
| 5 | event serialization & storage | 144,880 | 187,084 | +42,204 | +29.1% | 3.67 | **4.67** | **gps** |
| 6 | traces in Supabase, schema | 120,869 | 120,659 | −210 | −0.2% | **4.83** | 4.00 | baseline |
| 7 | api-types package wiring | 116,610 | 125,015 | +8,405 | +7.2% | 3.83 | **4.83** | **gps** |
| 8 | portal → api → db request path | 215,742 | 215,527 | −215 | −0.1% | 4.00 | **4.83** | **gps** |
| 9 | Railway/Docker deploy boundaries | 206,948 | 155,427 | **−51,521** | **−24.9%** | 4.00 | 4.33 | tie |
| 10 | replay state reconstruction | 121,257 | 129,780 | +8,523 | +7.0% | 4.17 | 4.00 | tie |

Tokens are total input (raw + cache_creation + cache_read). Quality is the mean of correctness, specificity, and completeness from the Sonnet judge over two A/B-swapped runs.

## Aggregates

**Tokens:**
- Baseline input total: **1,467,555**
- GPS input total: **1,488,641**
- **Δ: +21,086 (+1.4%)** — GPS used *slightly more* input tokens.
- Output: baseline 43,183 → GPS 55,147 (**+27.7%** longer answers).

**Quality (Sonnet judge, mean over 20 judgments per side, 1–5):**

| dim | baseline | gps |
|---|---:|---:|
| correctness | 4.15 | **4.20** |
| specificity | 4.15 | **4.70** |
| completeness | 3.80 | **4.50** |
| **overall** | **4.03** | **4.47** (+11%) |

**Judge wins across 20 blinded comparisons (1 parse error):** baseline **6**, gps **13**, tie 0.

## Takeaway

GPS did **not** save input tokens at the prompt level on this corpus — total input was 1.4% higher, output 28% higher. The README's "300–600 tok/turn" framing doesn't survive contact with `claude -p`, which aggressively explores via Glob/Read/Grep regardless of injected context. GPS's text injection is *additive* to that exploration rather than a substitute for it.

What GPS *did* deliver was **answer quality**: +11% overall, with double-digit gains on specificity and completeness, and 13 of 19 valid judgments. The qualitative pattern is concrete — GPS answers cite real symbols and line numbers (`replayRun:14`, `applyMutations:58`, `setAtPath:157`) where baseline hand-waves at file-level.

**Conclusion:** lead the messaging with quality, not tokens. The actual token-savings story requires GPS to *replace* Claude's exploration (e.g. authoritative system-prompt framing, MCP-pull instead of text-inject, or richer in-line code snippets so Glob/Read calls become unnecessary). That's a follow-up project; this dogfood is the baseline measurement.

## Reproducing

1. Build GPS: `pnpm install && pnpm build` in this repo.
2. Two fresh clones of target repo at the same SHA. One gets `gps init && gps install claude && gps index`.
3. Run `gps install claude --use-local` so hooks/MCP point at the absolute path of the built CLI. (Pre `gps v0.3` this required manually rewiring `.claude/settings.json` and `.mcp.json`; the `--use-local` flag is what removed that step.)
4. Run 10 prompts × 2 variants with `claude -p --output-format json`. Capture `usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}`.
5. Run Sonnet judge from a neutral cwd with no repo context. Score blinded A/B, swap order, average.

Raw artifacts from this run (token CSV, judge CSV, per-prompt answer texts, raw claude JSON) live locally at `/tmp/gps-bench/` on the run machine — not committed because of size and PII risk in absolute paths. Methodology is fully reproducible from this README.
