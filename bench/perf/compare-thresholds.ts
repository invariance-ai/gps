/**
 * compare-thresholds — diff two perf JSON snapshots and fail on regression.
 *
 * Usage:
 *   tsx bench/perf/compare-thresholds.ts \
 *     --baseline bench/baselines/perf-self.json \
 *     --current bench/perf/results/current.json \
 *     [--md-out path] [--json-out path] \
 *     [--query-fail 0.30] [--index-fail 0.30] [--tokens-warn 0.15] \
 *     [--query-tool get_context]
 *
 * Exit code: 0 if no FAIL thresholds breached, 1 otherwise. WARNs never fail.
 *
 * The default query tool tracked for the warm-p50 latency gate is
 * `get_context` (the per-tool harness in bench:perf doesn't have a literal
 * "gps-brief" entry — get_context is the closest analog and is what the
 * brief response is built on).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

interface PerfSnapshotQuery {
  tool: string;
  cold: { p50: number; p95: number };
  warm: { p50: number; p95: number };
  tokens_mean: number;
  tokens_p95: number;
}

interface PerfSnapshotCorpus {
  corpus: string;
  index: {
    files: number;
    symbols: number;
    edges: number;
    scan_ms: number;
    parse_ms: number;
    build_ms: number;
    write_ms: number;
    total_ms: number;
  };
  queries: PerfSnapshotQuery[];
  five_query_tokens: number;
  five_query_ms: number;
}

interface PerfSnapshot {
  version: number;
  generated_at: string;
  node: string;
  corpora: PerfSnapshotCorpus[];
}

interface Args {
  baseline: string;
  current: string;
  mdOut?: string;
  jsonOut?: string;
  queryFail: number;
  indexFail: number;
  tokensWarn: number;
  queryTool: string;
}

interface RowFinding {
  corpus: string;
  metric: string;
  baseline: number;
  current: number;
  delta_pct: number;
  threshold_pct: number;
  level: "PASS" | "WARN" | "FAIL";
  note?: string;
}

function parseArgs(argv: string[]): Args {
  const a = argv.slice(2);
  const out: Partial<Args> = {
    queryFail: 0.30,
    indexFail: 0.30,
    tokensWarn: 0.15,
    queryTool: "get_context",
  };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === "--baseline") out.baseline = a[++i];
    else if (k === "--current") out.current = a[++i];
    else if (k === "--md-out") out.mdOut = a[++i];
    else if (k === "--json-out") out.jsonOut = a[++i];
    else if (k === "--query-fail") out.queryFail = Number(a[++i]);
    else if (k === "--index-fail") out.indexFail = Number(a[++i]);
    else if (k === "--tokens-warn") out.tokensWarn = Number(a[++i]);
    else if (k === "--query-tool") out.queryTool = a[++i];
    else if (k === "--help" || k === "-h") {
      console.log("usage: compare-thresholds --baseline <path> --current <path> [--md-out <p>] [--json-out <p>] [--query-fail 0.30] [--index-fail 0.30] [--tokens-warn 0.15] [--query-tool get_context]");
      process.exit(0);
    }
  }
  if (!out.baseline || !out.current) {
    console.error("error: --baseline and --current are required");
    process.exit(2);
  }
  return out as Args;
}

async function loadSnapshot(p: string): Promise<PerfSnapshot> {
  const raw = await readFile(p, "utf8");
  return JSON.parse(raw) as PerfSnapshot;
}

function pctDelta(base: number, curr: number): number {
  if (base === 0) return curr === 0 ? 0 : Infinity;
  return (curr - base) / base;
}

function fmtPct(x: number): string {
  if (!Number.isFinite(x)) return "∞";
  const sign = x > 0 ? "+" : "";
  return `${sign}${(x * 100).toFixed(1)}%`;
}

function fmtNum(x: number): string {
  if (x >= 1000) return `${(x / 1000).toFixed(2)}k`;
  if (x >= 10) return x.toFixed(0);
  return x.toFixed(2);
}

function compare(baseline: PerfSnapshot, current: PerfSnapshot, args: Args): {
  rows: RowFinding[];
  skipped: string[];
} {
  const baseMap = new Map(baseline.corpora.map((c) => [c.corpus, c]));
  const rows: RowFinding[] = [];
  const skipped: string[] = [];

  for (const curr of current.corpora) {
    const base = baseMap.get(curr.corpus);
    if (!base) {
      skipped.push(`${curr.corpus} — not in baseline (new corpus, skipped cleanly)`);
      continue;
    }

    // Indexing total_ms — FAIL gate
    {
      const delta = pctDelta(base.index.total_ms, curr.index.total_ms);
      rows.push({
        corpus: curr.corpus,
        metric: "indexing.total_ms",
        baseline: base.index.total_ms,
        current: curr.index.total_ms,
        delta_pct: delta,
        threshold_pct: args.indexFail,
        level: delta > args.indexFail ? "FAIL" : "PASS",
      });
    }

    // Find the target query tool on both sides
    const baseQ = base.queries.find((q) => q.tool === args.queryTool);
    const currQ = curr.queries.find((q) => q.tool === args.queryTool);
    if (!baseQ || !currQ) {
      skipped.push(`${curr.corpus}.${args.queryTool} — missing on ${!baseQ ? "baseline" : "current"}`);
    } else {
      // warm p50 — FAIL gate
      {
        const delta = pctDelta(baseQ.warm.p50, currQ.warm.p50);
        rows.push({
          corpus: curr.corpus,
          metric: `${args.queryTool}.warm.p50`,
          baseline: baseQ.warm.p50,
          current: currQ.warm.p50,
          delta_pct: delta,
          threshold_pct: args.queryFail,
          level: delta > args.queryFail ? "FAIL" : "PASS",
          note: "warm-cache query latency",
        });
      }
      // tokens_mean — WARN only
      {
        const delta = pctDelta(baseQ.tokens_mean, currQ.tokens_mean);
        rows.push({
          corpus: curr.corpus,
          metric: `${args.queryTool}.tokens_mean`,
          baseline: baseQ.tokens_mean,
          current: currQ.tokens_mean,
          delta_pct: delta,
          threshold_pct: args.tokensWarn,
          level: delta > args.tokensWarn ? "WARN" : "PASS",
        });
      }
    }
  }

  return { rows, skipped };
}

function renderMarkdown(
  baseline: PerfSnapshot,
  current: PerfSnapshot,
  rows: RowFinding[],
  skipped: string[],
  args: Args,
): string {
  const L: string[] = [];
  L.push("## Perf gates — bench:perf");
  L.push("");
  L.push(`baseline: \`${path.basename(args.baseline)}\` generated ${baseline.generated_at} on ${baseline.node}`);
  L.push(`current : generated ${current.generated_at} on ${current.node}`);
  L.push("");
  L.push("| corpus | metric | baseline | current | Δ | threshold | level |");
  L.push("|---|---|---:|---:|---:|---:|:---:|");
  for (const r of rows) {
    const badge =
      r.level === "FAIL" ? "**FAIL**" : r.level === "WARN" ? "*WARN*" : "ok";
    L.push(
      `| ${r.corpus} | ${r.metric} | ${fmtNum(r.baseline)} | ${fmtNum(r.current)} | ${fmtPct(r.delta_pct)} | ${fmtPct(r.threshold_pct)} | ${badge} |`,
    );
  }
  if (skipped.length > 0) {
    L.push("");
    L.push("Skipped:");
    for (const s of skipped) L.push(`- ${s}`);
  }
  const fails = rows.filter((r) => r.level === "FAIL").length;
  const warns = rows.filter((r) => r.level === "WARN").length;
  L.push("");
  L.push(
    fails > 0
      ? `**Result: FAIL** — ${fails} threshold breach(es), ${warns} warning(s).`
      : warns > 0
        ? `Result: PASS (with ${warns} warning(s)).`
        : `Result: PASS.`,
  );
  return L.join("\n") + "\n";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const baseline = await loadSnapshot(args.baseline);
  const current = await loadSnapshot(args.current);
  const { rows, skipped } = compare(baseline, current, args);
  const md = renderMarkdown(baseline, current, rows, skipped, args);
  process.stdout.write(md);

  if (args.mdOut) {
    await mkdir(path.dirname(args.mdOut), { recursive: true });
    await writeFile(args.mdOut, md);
  }
  if (args.jsonOut) {
    await mkdir(path.dirname(args.jsonOut), { recursive: true });
    await writeFile(
      args.jsonOut,
      JSON.stringify({ rows, skipped, args }, null, 2) + "\n",
    );
  }

  const failed = rows.some((r) => r.level === "FAIL");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
