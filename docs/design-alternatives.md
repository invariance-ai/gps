# Design Alternatives Evaluation

Evals on the *design* of `gps`, not the product thesis. The wedge (callable structural+invariant context for coding agents) is assumed correct. The question here: are the architectural picks in the current plan the right ones?

Scoring: 1 (worst) to 5 (best) on each criterion. Higher is better for the project.

Criteria key:
- **Cost** = implementation/maintenance cost (5 = cheap)
- **Lat** = query latency (5 = fast)
- **P/R** = precision/recall of returned context (5 = best)
- **Def** = defensibility / moat (5 = hardest to clone)
- **Friction** = developer adoption friction (5 = lowest friction)

---

## 1. Indexing approach

| Option | Cost | Lat | P/R | Def | Friction | Notes |
|---|---|---|---|---|---|---|
| A: tree-sitter only | 5 | 5 | 2 | 1 | 5 | Misses cross-file refs, no type info, dies on dynamic dispatch |
| B: tree-sitter + LSP (current) | 3 | 3 | 4 | 3 | 3 | tsserver/pyright are heavy daemons; cold start pain |
| C: full compiler frontend (tsc / mypy API) | 1 | 2 | 5 | 3 | 2 | Best precision; per-language rewrite; tsc is slow on 100k+ LOC |
| D: stack-graphs | 2 | 4 | 4 | 4 | 3 | GitHub-grade resolution, language-agnostic spec, but small ecosystem and steep learning curve |

**Recommendation: keep B as default, but architect the resolver as a swappable interface so D (stack-graphs) can replace LSP per-language once a grammar+rules pair is mature.** LSP gives you "good enough" cross-file resolution today with 2 languages; stack-graphs becomes attractive when you expand to Go/Rust/Java because you avoid running 4 LSPs. C is a trap: tsc's compiler API gives perfect answers but at 5-10x the latency budget.

**Plan delta:** soft — abstract the resolver layer now so stack-graphs is a v1 swap, not a rewrite.

---

## 2. Storage

| Option | Cost | Lat | P/R | Def | Friction | Notes |
|---|---|---|---|---|---|---|
| A: Kuzu (current) | 3 | 4 | 4 | 3 | 3 | Native graph queries, columnar, ~50MB/100k LOC, young project, Node bindings rough |
| B: SQLite + adjacency | 5 | 4 | 4 | 2 | 5 | Universally available, every dev already has it, recursive CTEs handle traversal up to ~3 hops well |
| C: In-memory + JSON snapshot | 5 | 5 | 4 | 1 | 5 | Sub-ms queries, no DB dep; breaks past ~500k LOC, slow cold start |
| D: DuckDB | 4 | 5 | 4 | 2 | 4 | Columnar OLAP, great for analytics on graph; graph traversal is awkward without recursive SQL |

**Recommendation: switch default to B (SQLite) for v0, keep Kuzu as an opt-in for large monorepos.** The query patterns gps actually runs (callers, callees, tests-for-symbol, 1-3 hop impact) are not deep enough to need a real graph engine. SQLite means zero install friction, every CI has it, and the moat isn't in the DB choice anyway — it's in the strands and invariants. Kuzu adds a binary dependency that complicates the npm distribution story (axis 7).

**Plan delta:** swap Kuzu → SQLite as default. Keep Kuzu behind `gps config storage=kuzu` for >500k LOC repos.

---

## 3. Output format to the agent

| Option | Cost | Lat | P/R | Def | Friction | Notes |
|---|---|---|---|---|---|---|
| A: Structured JSON (current) | 5 | 5 | 4 | 2 | 4 | Easy for tool chains; LLMs spend tokens parsing braces |
| B: Compact markdown / plain text | 5 | 5 | 4 | 2 | 5 | LLM-native, ~30-40% fewer tokens than equivalent JSON, harder to chain programmatically |
| C: Custom DSL | 2 | 5 | 4 | 3 | 1 | Densest but every agent vendor must learn it; nonstarter |
| D: Hybrid (markdown + JSON metadata) | 4 | 5 | 5 | 3 | 4 | Best of both: agent reads markdown, downstream tools read JSON sidecar |

**Recommendation: ship D (hybrid) — markdown body + a `metadata` field with structured refs.** The MCP spec already supports structured + text content blocks; use both. Pure JSON wastes tokens (your own benchmark target is "2-3x fewer tokens on repo exploration" — output format dominates this). Pure markdown loses tool-chaining (impact_of → tests_for → run_tests).

**Plan delta:** hard — change MCP tool outputs from JSON-only to hybrid markdown+structured. This is one of the highest-leverage changes for hitting the token-efficiency benchmark.

---

## 4. Invariants representation

| Option | Cost | Lat | P/R | Def | Friction | Notes |
|---|---|---|---|---|---|---|
| A: YAML user-asserted (current) | 5 | 5 | 3 | 3 | 3 | Simple; binds by symbol name; fragile to refactor; users must write rules |
| B: Code comments / `@invariant` annotations | 4 | 5 | 4 | 3 | 4 | Lives with code, survives refactor, discoverable in review |
| C: Semgrep-style pattern rules | 2 | 4 | 5 | 4 | 2 | Executable, checkable in CI, but writing patterns is a skill |
| D: NL matched by LLM at query time | 4 | 2 | 3 | 4 | 5 | Zero authoring friction; nondeterministic; latency + cost per query |

**Recommendation: A + B + C as layered tiers, not one-of.** Default to A (YAML) because it's the quickest to author and demo. Add B (annotations) for invariants tightly bound to a function — these survive renames. Offer C (Semgrep import) as an advanced tier so existing Semgrep users get value day one. Skip D for v0: an LLM-matched invariant that fires nondeterministically destroys the "evidence-backed" positioning.

**Plan delta:** medium — keep YAML as v0 default, but design the invariant matcher to accept multiple sources (YAML, code annotations, Semgrep rule files) behind one interface. Ship YAML+annotations in v0, Semgrep import in v1.

---

## 5. MCP surface granularity

| Option | Cost | Lat | P/R | Def | Friction | Notes |
|---|---|---|---|---|---|---|
| A: Many narrow tools (current) | 4 | 5 | 4 | 3 | 3 | Clear semantics; each tool is independently cacheable; risk: agents don't know which to call |
| B: One mega-tool `ask(symbol, what)` | 5 | 4 | 3 | 2 | 5 | LLM picks intent in natural language; harder to evaluate; less precise |
| C: Retrieval API + `prepare_edit` planner | 3 | 4 | 5 | 4 | 4 | Planner returns "here's everything you need before editing X"; matches the wedge exactly |

**Recommendation: A + C combined. Keep narrow tools but add `prepare_edit(symbol)` as a meta-tool that internally calls all the others and returns a single bundle.** This matches the user-facing pitch ("before your agent edits, it asks gps…") more directly than 7 separate tools. Narrow tools stay for agents/devs who want finer control. B is wrong: a mega-tool with a free-form "what" parameter is harder to cache, harder to score in benchmarks, and gives no traction for telemetry on which intent is most common.

**Plan delta:** medium — add `prepare_edit` as the headline MCP tool. Demote the 7 narrow tools to "advanced" in the README. Most agents will only ever call `prepare_edit`.

---

## 6. Indexing trigger

| Option | Cost | Lat | P/R | Def | Friction | Notes |
|---|---|---|---|---|---|---|
| A: Manual init + `--watch` (current) | 5 | 5 | 4 | 2 | 3 | Predictable; users forget to re-index; watcher daemon eats RAM |
| B: Git hook on commit | 4 | 5 | 4 | 2 | 4 | Updates exactly when code changes; CI-friendly; misses uncommitted edits |
| C: Lazy per-symbol on first call | 3 | 2 | 4 | 4 | 5 | Zero upfront cost; first call slow; great for huge repos / cold demos |
| D: Cloud-hosted continuously updated | 1 | 5 | 5 | 5 | 2 | Best UX once set up; auth, privacy, pricing all complicate v0 |

**Recommendation: A as default with B added in v0, C as a fallback for stale indices, D deferred to paid tier.** Concretely: `gps init` installs a git post-commit hook (opt-in via prompt), the watcher stays for active dev, and any query against an unindexed symbol triggers a partial lazy index for that symbol's neighborhood. This gives the "it just works" feel without the cloud dependency. D is in the deferred-decisions section of the plan already; leave it there.

**Plan delta:** small — add the git-hook installer to `gps init` and add the lazy fallback path in the query layer.

---

## 7. Distribution

| Option | Cost | Lat | P/R | Def | Friction | Notes |
|---|---|---|---|---|---|---|
| A: npm `@invariance/gps` (current) | 5 | 4 | 4 | 2 | 3 | Easy for TS users; Python devs hate installing Node for a Python tool; native deps (tree-sitter, Kuzu) cause install pain |
| B: Standalone binary (Go/Rust rewrite) | 1 | 5 | 4 | 3 | 5 | One curl-install; language-agnostic users; massive rewrite cost; loses MCP SDK ergonomics |
| C: Multi-channel (npm + pipx + brew) | 3 | 4 | 4 | 3 | 5 | Meet users where they are; CI complexity; same TS core under each |
| D: Hosted service + thin local proxy | 2 | 3 | 5 | 5 | 2 | Strong moat; but the OSS wedge dies if the daily-use path needs a login |

**Recommendation: C (multi-channel) — npm primary, pipx and brew as wrappers around the same binary.** Python devs will not `npm install -g` a tool to index their Django repo; this is the single biggest adoption gotcha. Use `pkg`/`bun build --compile` or similar to ship a single-binary artifact and wrap it for each channel; no Go/Rust rewrite needed. Defer B until traction justifies it. D becomes the paid tier later as the plan already implies.

**Plan delta:** medium — extend the v0 release pipeline beyond npm to include a self-contained binary published via Homebrew tap and pipx-installable wheel. This is mostly packaging work; the TS core stays.

---

## Summary scorecard (current plan vs recommended)

| Axis | Current pick | Right pick? | Recommended |
|---|---|---|---|
| 1 Indexing | tree-sitter + LSP | Yes (now) | B now, abstract for D later |
| 2 Storage | Kuzu | No | SQLite default, Kuzu opt-in |
| 3 Output | JSON | No | Hybrid markdown + JSON metadata |
| 4 Invariants | YAML | Partially | YAML + annotations v0; Semgrep v1 |
| 5 MCP surface | 7 narrow tools | Partially | Add `prepare_edit` meta-tool, demote others |
| 6 Index trigger | manual + watch | Mostly | Add git-hook + lazy fallback |
| 7 Distribution | npm | No | Multi-channel npm + pipx + brew |

---

## Recommended deltas from current plan

Ordered by leverage on the v0 success criteria (token efficiency, latency, adoption):

1. **Output format → hybrid (axis 3).** Highest leverage. Directly moves the token-efficiency benchmark. One-day change; touches MCP server + CLI pretty-printer only.
2. **Storage → SQLite default, Kuzu opt-in (axis 2).** Removes a young native dependency from the install path; SQLite is already on every dev machine. Cuts install-failure tickets to near zero.
3. **Distribution → multi-channel (axis 7).** Python-heavy repos are half the v0 target. Ship `pipx install gps` and `brew install gps` alongside npm. Same binary, three wrappers.
4. **Add `prepare_edit` MCP tool (axis 5).** Matches the wedge language verbatim. Most agents will call only this; narrow tools become escape hatches.
5. **Invariants: add `@invariant` code annotations alongside YAML (axis 4).** Survives refactors, lives in code review, lower friction than YAML for function-local rules.
6. **Index trigger: git post-commit hook + lazy per-symbol fallback (axis 6).** Removes the "I forgot to re-index" failure mode that will dominate early bug reports.
7. **Abstract the resolver interface for future stack-graphs swap (axis 1).** Architectural hygiene; no v0 user-visible change. Pays off when you add Go/Rust.

None of these change the wedge. They reduce install friction, cut token usage, and remove failure modes that would otherwise show up in the first 100 GitHub issues. If only three ship in v0: do 1, 2, 4.
