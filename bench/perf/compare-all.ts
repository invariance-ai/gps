/**
 * Side-by-side bench: GPS vs ripgrep vs codebase-memory-mcp.
 *
 * Measures three axes per tool on the same sample of symbols:
 *   - tokens (mean, p95) — char/4 approximation
 *   - latency (p50, p95, mean ms)
 *   - accuracy (recall on callers/callees/tests, scored by `claude -p`)
 *
 * Usage:
 *   pnpm bench:compare -- --corpus flask
 *   pnpm bench:compare -- --corpus django --skip-accuracy
 *   pnpm bench:compare -- --corpus self --skip-cmm
 *
 * `--corpus self` benchmarks against this repo (skips clone).
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  readIndex,
  clearIndexCache,
  open,
  getContext,
} from "@invariance/gps-core";
import { approxTokens, stats, timeIt, type LatencyStats } from "./measure.js";
import { CORPORA, ensureCorpus } from "./corpora.js";
import { indexCorpus } from "./run-index.js";
import { runRgBundle } from "./baseline-rg.js";
import { runCmmBundle } from "./baseline-cmm.js";
import {
  buildOracle,
  getContextOutput,
  scoreTool,
  summarize,
  isClaudeAvailable,
  type ToolOutput,
  type ToolAccuracySummary,
} from "./accuracy.js";

interface CliOpts {
  corpus: string;
  sampleSize: number;
  out: string;
  skipCmm: boolean;
  skipAccuracy: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const args = argv.slice(2);
  let corpus = "flask";
  let sampleSize = 10;
  let out = "";
  let skipCmm = false;
  let skipAccuracy = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--corpus" || a === "-c") corpus = args[++i];
    else if (a === "--sample-size" || a === "-n") sampleSize = parseInt(args[++i], 10);
    else if (a === "--out") out = args[++i];
    else if (a === "--skip-cmm") skipCmm = true;
    else if (a === "--skip-accuracy") skipAccuracy = true;
  }
  if (!out) {
    const date = new Date().toISOString().slice(0, 10);
    out = path.join("bench/perf/results", `compare-${corpus}-${date}.md`);
  }
  return { corpus, sampleSize, out, skipCmm, skipAccuracy };
}

async function resolveCorpusRoot(corpus: string): Promise<string> {
  if (corpus === "self") return process.cwd();
  const c = CORPORA[corpus];
  if (!c) throw new Error(`unknown corpus: ${corpus}. known: self, ${Object.keys(CORPORA).join(", ")}`);
  return ensureCorpus(c);
}

function pickSamples(symbols: { name: string; file: string }[], n: number): string[] {
  const byFile = new Map<string, string[]>();
  for (const s of symbols) {
    const arr = byFile.get(s.file) ?? [];
    arr.push(s.name);
    byFile.set(s.file, arr);
  }
  const files = [...byFile.keys()];
  const out: string[] = [];
  let i = 0;
  while (out.length < n && files.length > 0) {
    const f = files[i % files.length];
    const names = byFile.get(f)!;
    const name = names.shift();
    if (name) out.push(name);
    if (names.length === 0) {
      files.splice(i % files.length, 1);
      continue;
    }
    i++;
  }
  return out;
}

interface GpsRunResult {
  latency: LatencyStats;
  tokens_mean: number;
  tokens_p95: number;
  outputs: ToolOutput[];
}

async function runGps(root: string, symbols: string[], mode: "brief" | "full"): Promise<GpsRunResult> {
  clearIndexCache();
  const ctx = await open(root);
  const lats: number[] = [];
  const toks: number[] = [];
  const outputs: ToolOutput[] = [];
  for (const sym of symbols) {
    const { ms, result } = await timeIt(async () =>
      getContext(
        {
          symbol: sym,
          depth: 2,
          strands: ["structural", "tests", "provenance", "invariants"],
          mode,
          budget: mode === "brief" ? 1500 : 0,
        },
        ctx,
      ).catch(() => null),
    );
    lats.push(ms);
    const text = result ? JSON.stringify(result, null, 2) : "";
    toks.push(approxTokens(text));
    outputs.push({ symbol: sym, tool: `gps-${mode}`, text });
  }
  return {
    latency: stats(lats),
    tokens_mean: toks.reduce((a, b) => a + b, 0) / Math.max(1, toks.length),
    tokens_p95: stats(toks).p95,
    outputs,
  };
}

interface Row {
  tool: string;
  tokens_mean: number;
  tokens_p95: number;
  latency_p50: number;
  latency_p95: number;
  latency_mean: number;
  recall_overall?: number;
  recall_callers?: number;
  recall_callees?: number;
  recall_tests?: number;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function pct(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(0)}%`;
}

function renderTable(rows: Row[], baseline?: Row): string {
  const headers = [
    "tool",
    "tokens (mean)",
    "tokens (p95)",
    "ms p50",
    "ms p95",
    "ms mean",
    "recall",
    "callers",
    "callees",
    "tests",
  ];
  const lines: string[] = [];
  lines.push("| " + headers.join(" | ") + " |");
  lines.push("|" + headers.map(() => "---").join("|") + "|");
  for (const r of rows) {
    const tokensSavedPct =
      baseline && r.tokens_mean > 0 && baseline.tokens_mean > 0
        ? ` (${(((baseline.tokens_mean - r.tokens_mean) / baseline.tokens_mean) * 100).toFixed(0)}% vs ${baseline.tool})`
        : "";
    lines.push(
      "| " +
        [
          r.tool,
          fmt(r.tokens_mean) + tokensSavedPct,
          fmt(r.tokens_p95),
          fmt(r.latency_p50),
          fmt(r.latency_p95),
          fmt(r.latency_mean),
          pct(r.recall_overall),
          pct(r.recall_callers),
          pct(r.recall_callees),
          pct(r.recall_tests),
        ].join(" | ") +
        " |",
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  console.log(`\n=== compare-all: ${opts.corpus} (n=${opts.sampleSize}) ===`);

  const root = await resolveCorpusRoot(opts.corpus);
  console.log(`  corpus root: ${root}`);

  // Ensure GPS index exists (re-index if --corpus self or fresh corpus).
  console.log("  indexing…");
  const idx = await indexCorpus(root);
  console.log(`    ${idx.files} files, ${idx.symbols} symbols in ${idx.total_ms.toFixed(0)}ms`);

  const index = await readIndex(root);
  const symbols = pickSamples(index.symbols, opts.sampleSize);
  console.log(`  sampled ${symbols.length} symbols`);

  // GPS brief + full
  console.log("  running gps (brief)…");
  const gpsBrief = await runGps(root, symbols, "brief");
  console.log(`    tokens≈${Math.round(gpsBrief.tokens_mean)}  ms p50=${gpsBrief.latency.p50.toFixed(2)}`);

  console.log("  running gps (full)…");
  const gpsFull = await runGps(root, symbols, "full");
  console.log(`    tokens≈${Math.round(gpsFull.tokens_mean)}  ms p50=${gpsFull.latency.p50.toFixed(2)}`);

  // rg
  console.log("  running rg…");
  const rg = await runRgBundle(root, symbols);
  console.log(`    tokens≈${Math.round(rg.stats.tokens_mean)}  ms p50=${rg.stats.latency.p50.toFixed(2)}`);
  const rgOutputs: ToolOutput[] = rg.results.map((r) => ({
    symbol: r.symbol,
    tool: "rg",
    text: r.output,
  }));

  // codebase-memory-mcp
  let cmmStats: { tokens_mean: number; tokens_p95: number; latency: LatencyStats; resolved_tool: string } | null = null;
  let cmmOutputs: ToolOutput[] = [];
  let cmmReason = "";
  if (!opts.skipCmm) {
    console.log("  running codebase-memory-mcp…");
    const cmm = await runCmmBundle(root, symbols);
    if (cmm.available && cmm.stats && cmm.results) {
      cmmStats = cmm.stats;
      cmmOutputs = cmm.results.map((r) => ({ symbol: r.symbol, tool: "cmm", text: r.output }));
      console.log(`    tool=${cmm.stats.resolved_tool}  tokens≈${Math.round(cmm.stats.tokens_mean)}  ms p50=${cmm.stats.latency.p50.toFixed(2)}`);
    } else {
      cmmReason = cmm.reason ?? "unavailable";
      console.log(`    unavailable: ${cmmReason}`);
    }
  }

  // Accuracy
  let accuracy: ToolAccuracySummary[] = [];
  let accuracyReason = "";
  if (!opts.skipAccuracy) {
    const claudeOk = await isClaudeAvailable();
    if (!claudeOk) {
      accuracyReason = "`claude` CLI not on PATH — skipped accuracy scoring";
      console.log(`  accuracy: ${accuracyReason}`);
    } else {
      console.log("  building oracle from GPS index…");
      const oracle = await buildOracle(root, symbols);
      const oracleSymbols = oracle.map((o) => o.symbol);
      // Limit accuracy scoring to first 5 symbols to keep claude -p cost bounded.
      const accSyms = oracleSymbols.slice(0, Math.min(5, oracleSymbols.length));
      const accGpsBrief: ToolOutput[] = [];
      for (const s of accSyms) {
        accGpsBrief.push({ symbol: s, tool: "gps-brief", text: await getContextOutput(root, s) });
      }
      const accRg = rgOutputs.filter((o) => accSyms.includes(o.symbol));
      const accCmm = cmmOutputs.filter((o) => accSyms.includes(o.symbol));
      const accOracle = oracle.filter((o) => accSyms.includes(o.symbol));
      console.log(`  scoring ${accSyms.length} symbols × 3 questions × ${1 + (accRg.length > 0 ? 1 : 0) + (accCmm.length > 0 ? 1 : 0)} tools via claude -p…`);
      const scores = await scoreTool(accOracle, [...accGpsBrief, ...accRg, ...accCmm]);
      accuracy = summarize(scores);
    }
  }

  const accByTool = new Map(accuracy.map((a) => [a.tool, a]));
  const rows: Row[] = [
    {
      tool: "gps-brief",
      tokens_mean: gpsBrief.tokens_mean,
      tokens_p95: gpsBrief.tokens_p95,
      latency_p50: gpsBrief.latency.p50,
      latency_p95: gpsBrief.latency.p95,
      latency_mean: gpsBrief.latency.mean,
      recall_overall: accByTool.get("gps-brief")?.overall_recall,
      recall_callers: accByTool.get("gps-brief")?.callers_recall,
      recall_callees: accByTool.get("gps-brief")?.callees_recall,
      recall_tests: accByTool.get("gps-brief")?.tests_recall,
    },
    {
      tool: "gps-full",
      tokens_mean: gpsFull.tokens_mean,
      tokens_p95: gpsFull.tokens_p95,
      latency_p50: gpsFull.latency.p50,
      latency_p95: gpsFull.latency.p95,
      latency_mean: gpsFull.latency.mean,
    },
    {
      tool: "rg",
      tokens_mean: rg.stats.tokens_mean,
      tokens_p95: rg.stats.tokens_p95,
      latency_p50: rg.stats.latency.p50,
      latency_p95: rg.stats.latency.p95,
      latency_mean: rg.stats.latency.mean,
      recall_overall: accByTool.get("rg")?.overall_recall,
      recall_callers: accByTool.get("rg")?.callers_recall,
      recall_callees: accByTool.get("rg")?.callees_recall,
      recall_tests: accByTool.get("rg")?.tests_recall,
    },
  ];
  if (cmmStats) {
    rows.push({
      tool: "codebase-memory-mcp",
      tokens_mean: cmmStats.tokens_mean,
      tokens_p95: cmmStats.tokens_p95,
      latency_p50: cmmStats.latency.p50,
      latency_p95: cmmStats.latency.p95,
      latency_mean: cmmStats.latency.mean,
      recall_overall: accByTool.get("cmm")?.overall_recall,
      recall_callers: accByTool.get("cmm")?.callers_recall,
      recall_callees: accByTool.get("cmm")?.callees_recall,
      recall_tests: accByTool.get("cmm")?.tests_recall,
    });
  }

  const rgRow = rows.find((r) => r.tool === "rg");
  const table = renderTable(rows, rgRow);

  const md: string[] = [];
  md.push(`# Compare-All: ${opts.corpus}`);
  md.push("");
  md.push(`- Date: ${new Date().toISOString()}`);
  md.push(`- Corpus root: \`${root}\``);
  md.push(`- Sample size: ${symbols.length}`);
  md.push(`- Token estimation: chars / 4`);
  if (cmmReason) md.push(`- codebase-memory-mcp: **${cmmReason}**`);
  if (accuracyReason) md.push(`- accuracy: **${accuracyReason}**`);
  md.push("");
  md.push("## Side-by-side");
  md.push("");
  md.push(table);
  md.push("");
  md.push("## Notes");
  md.push("");
  md.push("- `gps-brief` is the default mode (budget=1500); `gps-full` matches pre-PR behavior.");
  md.push("- `rg` bundle = `rg --json <symbol>` + `rg -A 5 -B 2 <symbol> | head -50` (what a no-tool agent would actually run).");
  md.push("- Recall is judged by `claude -p` extracting answers from each tool's output, scored against GPS's structural oracle (callers/callees) and GPS's testsForSymbol (tests). GPS's recall ceiling is therefore 1.0 by construction — the interesting numbers are whether rg/cmm can also recover those answers, and at what token cost.");

  await mkdir(path.dirname(opts.out), { recursive: true });
  await writeFile(opts.out, md.join("\n") + "\n");
  console.log(`\nwrote ${opts.out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
