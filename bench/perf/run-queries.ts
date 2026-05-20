import {
  readIndex,
  clearIndexCache,
  open,
  getContext,
  impactOf,
  resolveSymbol,
} from "@invariance/gps-core";
import { approxTokens, stats, timeIt, type LatencyStats } from "./measure.js";

export interface QueryStats {
  tool: string;
  cold: LatencyStats;
  warm: LatencyStats;
  tokens_mean: number;
  tokens_p95: number;
}

function pickSampleSymbols(symbols: { name: string; file: string }[], n: number): string[] {
  // Spread across files so we exercise different code paths.
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

export async function runQueries(root: string, sampleSize = 20, runs = 20): Promise<QueryStats[]> {
  // Load once to pick samples (doesn't count toward measurements).
  const index = await readIndex(root);
  const samples = pickSampleSymbols(index.symbols, sampleSize);

  const tools = ["get_context", "impact_of", "resolve"] as const;
  const results: QueryStats[] = [];

  for (const tool of tools) {
    const coldLats: number[] = [];
    const warmLats: number[] = [];
    const tokens: number[] = [];

    for (const sym of samples) {
      // Cold: clear cache so the next call re-reads index from disk.
      clearIndexCache();
      const ctxCold = await open(root);
      const { ms: cm, result: coldRes } = await timeIt(() => runOne(tool, sym, ctxCold));
      coldLats.push(cm);
      tokens.push(approxTokens(coldRes));

      // Warm: reuse open context for N runs, mirroring agent re-queries.
      const ctxWarm = await open(root);
      for (let i = 0; i < runs; i++) {
        const { ms } = await timeIt(() => runOne(tool, sym, ctxWarm));
        warmLats.push(ms);
      }
    }

    results.push({
      tool,
      cold: stats(coldLats),
      warm: stats(warmLats),
      tokens_mean: tokens.reduce((a, b) => a + b, 0) / tokens.length,
      tokens_p95: stats(tokens).p95,
    });
  }
  return results;
}

async function runOne(tool: string, sym: string, ctx: Awaited<ReturnType<typeof open>>): Promise<unknown> {
  try {
    if (tool === "get_context") {
      return await getContext(
        { symbol: sym, depth: 2, strands: ["structural", "tests", "provenance", "invariants"] },
        ctx,
      );
    }
    if (tool === "impact_of") {
      return await impactOf({ symbol: sym, hops: 1 }, ctx);
    }
    if (tool === "resolve") {
      return resolveSymbol(sym, ctx);
    }
  } catch {
    // Symbol resolution may fail on synthetic samples; null payload still
    // gives us a latency measurement.
    return null;
  }
  return null;
}

// 5-query agent-task simulation: pick 5 symbols, fetch full get_context,
// concat tokens. Mirrors codebase-memory-mcp's "5 structural queries" claim.
export async function runFiveQueryTask(root: string): Promise<{ total_tokens: number; total_ms: number }> {
  const index = await readIndex(root);
  const samples = pickSampleSymbols(index.symbols, 5);
  clearIndexCache();
  const ctx = await open(root);
  let total_tokens = 0;
  const t0 = performance.now();
  for (const sym of samples) {
    const r = await getContext(
      { symbol: sym, depth: 2, strands: ["structural", "tests", "provenance", "invariants"] },
      ctx,
    ).catch(() => null);
    total_tokens += approxTokens(r);
  }
  return { total_tokens, total_ms: performance.now() - t0 };
}
