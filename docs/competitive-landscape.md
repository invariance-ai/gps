# Competitive Landscape: `gps` vs. the "Repo Context for Agents" Market

**Scope.** Tools competing on the job: *give a coding agent better repo context before it edits code.* OSS and commercial, MCP-first and IDE-native.

**Date.** May 2026. v0 alpha of `gps`.

## Snapshot

The category split into four camps in 2025-26:

1. **Vector/semantic chunk RAG** (Cursor, Windsurf, Continue, Claude Context, Nia) — embed code, return chunks.
2. **AST / call-graph indexers** (Aider repomap, CodeGraph, code-graph-mcp, CodeGraphContext, Probe, Sverklo) — tree-sitter, PageRank, return symbols + edges.
3. **Hosted SaaS code intelligence** (Sourcegraph/Cody, Greptile) — graph + search + review, sold per-seat.
4. **Rule/invariant enforcement** (Semgrep, CodeQL) — pattern/dataflow rules, originally for security, now exposed to agents as skills/MCP.

`gps` sits at the **intersection of camps 2 and 4**: it ships a structural graph *and* a declarative invariants layer with evidence pointers. That intersection is what to defend.

## Per-Competitor Table

| Tool | URL | One-liner | Delivery | Approach | Returns | License/Pricing | Traction |
|---|---|---|---|---|---|---|---|
| **Smart-Grep** | (no canonical repo; appears only as benchmark baseline cited by Sverklo) | Symbol-aware grep wrapper, F1 0.49 on Sverklo's 90-task bench | CLI | Regex + symbol heuristics | Lines + symbol names | OSS | Low; cited mostly as a baseline |
| **Sverklo MCP** | sverklo.com | Local-first code intelligence MCP, the closest spiritual sibling to `gps` | MCP, CLI | Tree-sitter + BM25 + local ONNX embeddings + PageRank, fused via RRF | Ranked code chunks + symbol graph | MIT, free | Small but active; 43x fewer tokens than grep claim |
| **Nia / Nozomio** | trynia.ai, github.com/nozomio-labs/nia | Indexed packages + repos as agent-callable context | Hosted MCP | Vector RAG over repos, docs, 3000+ pre-indexed packages | Code snippets + doc passages | Commercial; YC S25 | Active; +27% Cursor eval claim |
| **Hyperspell** | hyperspell.com | Memory/context layer for AI agents (broader than code) | Hosted SDK | Pluggable connectors (Gmail/Slack/Notion + code) into a memory graph | Memory passages | Commercial; YC | Pivoting; not code-specific |
| **Sourcegraph Cody** | sourcegraph.com | Enterprise code search + Cody agent, now MCP-aware | IDE plugin + MCP | LSIF/SCIP graph + remote search + MCP tool calls | Files, symbols, refs, definitions | Commercial; enterprise seats | Established; serving F500 |
| **Aider repomap** | aider.chat/docs/repomap.html | Tree-sitter + PageRank repo map embedded in chat | CLI (aider only) | Tree-sitter tags + NetworkX PageRank, token-budgeted | Compact list of top-ranked symbols | Apache-2; OSS in aider | aider ~30k stars; foundational design |
| **RepoMapper** | github.com/pdavis68/RepoMapper | Aider's repomap, extracted + wrapped as MCP | MCP, CLI | Same as aider | Repo map text blob | OSS | Modest stars |
| **Cursor codebase indexing** | cursor.com/blog/secure-codebase-indexing | Proprietary embeddings indexed via Merkle-tree sync | IDE-internal | AST chunking -> custom embeddings -> Turbopuffer | Chunks injected into Cursor prompts | Closed; bundled in Cursor | Default in Cursor |
| **Continue.dev** | docs.continue.dev | Pluggable context providers (@codebase, @folder, ...) | IDE plugin + MCP | Embeddings + tree-sitter + SQL FTS, repo map for top LLMs | Chunks + repo map | Apache-2; OSS | ~22k stars; mature plugin |
| **Greptile** | greptile.com | Codebase graph + AI code-review agent | Hosted SaaS + API | Graph index of files/functions/deps; Claude Agent SDK reviews | Review comments, graph queries | $20-30/seat/mo; $0.45/Genius API call | Benchmark Series A, $180M val |
| **Windsurf / Codeium** | windsurf.com | M-Query Fast Context retrieval inside Windsurf IDE | IDE-internal | 768-dim embeddings of full local repo, M-Query retrieval | Chunks merged into Cascade prompt | Closed; per-seat | Cohere-scale traction |
| **Tabby ML** | github.com/TabbyML/tabby | Self-hosted Copilot alt with repo-level context indexing | Self-hosted server | Local embeddings + repo index, daily/commit re-index | Snippets in completion prompts | Apache-2 | ~32k stars |
| **Repo Prompt** | repoprompt.com | macOS app + MCP that auto-builds dense context bundles | Desktop + MCP + CLI | Tree-sitter "Code Maps" + heuristic file selection | Token-optimized prompt bundles | Commercial mac app | Niche but loyal |
| **CodeQL** | github.com/github/codeql | Treats code as a queryable database, dataflow + control flow | CLI + MCP wrappers (jordyzomer, neuralprogram) | Compiled semantic DB + QL queries | Query result sets (paths, sinks) | Free for OSS; commercial otherwise | GitHub-owned, standard for sec |
| **Semgrep** | semgrep.dev + github.com/semgrep/skills | Pattern-based static analysis; now ships Claude Code skills | CLI + Claude Skill + MCP | AST + light dataflow rules, custom rules per repo | Findings with rule + location | OSS + commercial AppSec | 10k+ stars; security-first |
| **Claude Context (Zilliz)** | github.com/zilliztech/claude-context | MCP plugin for semantic code search over the whole repo | MCP | BM25 + dense vectors (Milvus) | Ranked code chunks | Apache-2 | 10.9k stars |
| **CodeGraph (colbymchenry)** | github.com/colbymchenry/codegraph | Pre-indexed local code knowledge graph MCP for Claude Code | MCP | Tree-sitter -> SQLite + FTS, OS file watchers | Symbols, callers/callees, impact, routes | OSS | ~1.2k stars |
| **CodeGraphContext** | github.com/CodeGraphContext/CodeGraphContext | Code graph MCP backed by Neo4j/FalkorDB/LadybugDB | MCP + CLI | Tree-sitter -> graph DB, 15 langs | Callers, callees, hierarchies, complexity | OSS | ~3.2k stars |
| **code-graph-mcp (sdsrss)** | github.com/sdsrss/code-graph-mcp | AST knowledge graph MCP with route tracing + impact | MCP | Tree-sitter + SQLite + vec, RRF fusion | Call graph, HTTP routes, impact, dead code | OSS | ~28 stars, very active (140 releases) |
| **Probe** | github.com/probelabs/probe | AST-aware structural search, zero setup | MCP + CLI + SDK | Ripgrep + tree-sitter, returns whole AST blocks | Functions/classes (no mid-function chunks) | Apache-2 | ~590 stars |
| **jCodeMunch / CodeSight** | github.com/jgravelle/jcodemunch-mcp, cmillstead/codesight-mcp | Token-efficient symbol retrieval via byte offsets | MCP | Tree-sitter index + byte-offset extraction | Exact symbol bodies | OSS | <100 stars each |
| **codebase-memory-mcp** | github.com/DeusData/codebase-memory-mcp | 155-language indexer, single static binary | MCP | Persistent knowledge graph, sub-ms queries | Symbols + relations | OSS | Newcomer |
| **Repo Mapping / CodeRLM skills** | mcpmarket.com/tools/skills/repo-mapping, coderlm-codebase-explorer | Claude Code skills that wrap ast-grep / tree-sitter for symbol maps | Claude Skill | ast-grep / tree-sitter on demand | Symbol/import/export map | OSS skills | Early |

## Synthesis

### What is commodity now

- **Tree-sitter + PageRank-style repo map.** Aider productized it in 2023; in 2026 there are at minimum 8 MCP servers reimplementing the same idea (CodeGraph, CodeGraphContext, code-graph-mcp, Sverklo, Probe, jCodeMunch, CodeSight, codebase-memory-mcp). Stars range from 28 to 10.9k. **`gps`'s "structural" strand alone is undifferentiated.**
- **Vector RAG over chunks.** Cursor, Windsurf, Continue, Claude Context, Nia, Tabby — every major IDE and several MCP servers ship this. Token-savings claims (40-95% less than grep) are uniform and no longer credible as a differentiator.
- **Caller / callee / impact analysis.** CodeGraph and code-graph-mcp already expose `impact_of`-equivalent tools. This is table stakes for any AST-graph product.
- **Tests-for-symbol.** Implicit in any call-graph product. Continue and Sourcegraph already do this; `gps`'s "tests" strand is a polish layer, not a moat.

### Closest competitor

**Sverklo MCP.** It is the closest analog by architecture (local-first, tree-sitter + BM25 + ONNX + PageRank, MIT, MCP+CLI). The difference: Sverklo optimizes *retrieval quality* on a 90-task benchmark; `gps` optimizes *structured evidence shape* (4 named strands the agent can call individually). Sverklo wins on "find me code about X", `gps` wins on "what must I not break in X". They will collide.

Honorable mentions: **code-graph-mcp** matches the impact/route/dead-code surface area, and **Greptile** matches the graph-index ambition at SaaS scale.

### Where `gps` is actually defensible

Of the four strands, three (structural, tests, provenance) are commodity. The defensible wedge is narrower than the README suggests:

1. **Invariants as a first-class, agent-callable strand with evidence pointers.** No competitor in this list exposes `invariants_for(symbol)` returning declarative rules linked back to docs. The closest things — Semgrep rules and CodeQL queries — are *security-first*, *code-as-pattern*, and not authored by product/engineering leads. A `.gps/invariants.yml` authored by a PM saying "refunds > $1000 require finance approval" with a link to the policy doc is a meaningfully different artifact, and it is the only piece of `gps`'s output that an LLM cannot reconstruct from a tree-sitter pass.

2. **The "before they edit" contract / four-strand shape.** Not the strands themselves, but the *bundle* — `get_context` returning structure + tests + provenance + invariants in one shot — is a UX position no one else has explicitly staked. Sverklo et al. return ranked chunks; Greptile returns review comments; `gps` returns a decision-ready brief. Worth defending by making this output stable, citable, and diffable across runs.

### Honest recommendation

If `gps` shipped today as "yet another tree-sitter MCP with impact analysis", it would be the 9th such tool and would lose to Sverklo (retrieval quality), code-graph-mcp (feature breadth), and Greptile (distribution). The sharpest two differentiators to lean into:

- **Invariants.** Build the authoring UX (YAML + AI-assisted drafting from PRs/docs), the evidence link format, and a small library of starter invariants for common stacks (Stripe, auth, GDPR, multi-tenant isolation). This is the one strand no competitor has.
- **Runtime/data provenance (v1 roadmap).** OTel/Sentry/Datadog traces tying symbols to real production behavior, and data-layer touches (which tables/columns a symbol writes). No OSS competitor does this; it requires plumbing competitors won't build casually.

Deprioritize: yet another "we use 95% fewer tokens than grep" benchmark. That race is over and everyone claims to have won it.

## Sources

- [Sverklo MCP](https://sverklo.com/)
- [Nia / Nozomio](https://github.com/nozomio-labs/nia)
- [Hyperspell](https://www.hyperspell.com/)
- [Sourcegraph Cody MCP changelog](https://sourcegraph.com/changelog/mcp-context-gathering)
- [Aider repomap](https://aider.chat/2023/10/22/repomap.html)
- [Greptile pricing](https://www.greptile.com/pricing)
- [Continue.dev context providers](https://docs.continue.dev/customize/custom-providers)
- [Cursor secure codebase indexing](https://cursor.com/blog/secure-codebase-indexing)
- [Tabby ML](https://github.com/TabbyML/tabby)
- [Repo Prompt](https://repoprompt.com/)
- [Semgrep skills](https://github.com/semgrep/skills)
- [CodeQL MCP examples](https://github.com/neuralprogram/codeql-lsp-mcp)
- [Claude Context (Zilliz)](https://github.com/zilliztech/claude-context)
- [CodeGraph](https://github.com/colbymchenry/codegraph)
- [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext)
- [code-graph-mcp](https://github.com/sdsrss/code-graph-mcp)
- [Probe](https://github.com/probelabs/probe)
- [Windsurf context](https://docs.windsurf.com/context-awareness/overview)
