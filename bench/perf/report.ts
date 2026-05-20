import type { IndexResult } from "./run-index.js";
import type { QueryStats } from "./run-queries.js";

export interface CorpusReport {
  corpus: string;
  index: IndexResult;
  queries: QueryStats[];
  five_query_tokens: number;
  five_query_ms: number;
}

export function renderMarkdown(reports: CorpusReport[]): string {
  const L: string[] = [];
  L.push("# GPS perf bench");
  L.push("");
  L.push(`Generated: ${new Date().toISOString()}`);
  L.push("");
  L.push("## Indexing");
  L.push("");
  L.push("| Corpus | Files | Symbols | Edges | Scan ms | Parse ms | Build ms | Write ms | **Total ms** |");
  L.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of reports) {
    const i = r.index;
    L.push(`| ${r.corpus} | ${i.files} | ${i.symbols} | ${i.edges} | ${fmt(i.scan_ms)} | ${fmt(i.parse_ms)} | ${fmt(i.build_ms)} | ${fmt(i.write_ms)} | **${fmt(i.total_ms)}** |`);
  }
  L.push("");
  L.push("## Query latency (ms)");
  L.push("");
  L.push("| Corpus | Tool | Cold p50 | Cold p95 | Warm p50 | Warm p95 | Tokens (mean) |");
  L.push("|---|---|---:|---:|---:|---:|---:|");
  for (const r of reports) {
    for (const q of r.queries) {
      L.push(`| ${r.corpus} | ${q.tool} | ${fmt(q.cold.p50)} | ${fmt(q.cold.p95)} | ${fmt(q.warm.p50)} | ${fmt(q.warm.p95)} | ${Math.round(q.tokens_mean)} |`);
    }
  }
  L.push("");
  L.push("## 5-query agent task (tokens)");
  L.push("");
  L.push("| Corpus | Total tokens | Total ms |");
  L.push("|---|---:|---:|");
  for (const r of reports) {
    L.push(`| ${r.corpus} | ${r.five_query_tokens} | ${fmt(r.five_query_ms)} |`);
  }
  L.push("");
  L.push("## Reference: codebase-memory-mcp (their README)");
  L.push("");
  L.push("| Dimension | Their number |");
  L.push("|---|---|");
  L.push("| Django index | ~6s |");
  L.push("| Linux index | ~3min |");
  L.push("| Cypher query | <1ms |");
  L.push("| Name search | <10ms |");
  L.push("| 5 structural queries | ~3,400 tokens (vs ~412k grep) |");
  L.push("");
  L.push("> Token counts are approximate (chars/4, cl100k-equiv).");
  return L.join("\n");
}

function fmt(n: number): string {
  if (n < 10) return n.toFixed(2);
  if (n < 1000) return n.toFixed(0);
  return `${(n / 1000).toFixed(2)}k`;
}
