/**
 * codebase-memory-mcp baseline (DeusData/codebase-memory-mcp).
 *
 * Ships as a single static binary (curl|bash install), NOT an npm package.
 * We drive it via `cmm cli <tool> <json>` which is a one-shot mode that
 * mirrors a single MCP tool call. First step is index_repository (cached
 * across runs by cmm's persistent KG); then we call trace_path per symbol —
 * that returns callers + callees + hop counts, the closest analog to GPS's
 * get_context structural payload.
 *
 * CMM_BIN env overrides the binary path. Falls back to common install
 * locations and finally PATH.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { approxTokens, stats, timeIt, type LatencyStats } from "./measure.js";

function resolveCmmBin(): string {
  if (process.env.CMM_BIN && existsSync(process.env.CMM_BIN)) return process.env.CMM_BIN;
  const candidates = [
    `${process.env.HOME}/.local/bin/codebase-memory-mcp`,
    "/opt/homebrew/bin/codebase-memory-mcp",
    "/usr/local/bin/codebase-memory-mcp",
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return "codebase-memory-mcp";
}

const CMM_BIN = resolveCmmBin();

export interface CmmQueryResult {
  symbol: string;
  output: string;
  ms: number;
  tokens: number;
  tool: string;
}

export interface CmmStats {
  tool: "codebase-memory-mcp";
  latency: LatencyStats;
  tokens_mean: number;
  tokens_p95: number;
  resolved_tool: string;
}

export interface CmmRunResult {
  available: boolean;
  reason?: string;
  index_ms?: number;
  project?: string;
  stats?: CmmStats;
  results?: CmmQueryResult[];
}

interface CliResult {
  stdout: string;
  stderr: string;
  ms: number;
  code: number | null;
}

function runCli(args: string[], timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(CMM_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, ms: performance.now() - t0, code });
    };
    const killer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", () => {
      clearTimeout(killer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      finish(code);
    });
  });
}

/**
 * cmm wraps its tool reply in { content: [{ type: "text", text: "<json>" }] }.
 * Strip the envelope; keep the inner text so token counts reflect what the
 * agent actually sees.
 */
function unwrapContent(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { content?: Array<{ text?: string }> };
    const parts = (parsed.content ?? []).map((c) => c.text ?? "").filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
  } catch {
    /* fall through */
  }
  return trimmed;
}

function projectIdFor(repoPath: string): string {
  // cmm builds a project id from the absolute path by replacing path separators
  // with dashes. Mirror that so we can pass {project} to subsequent calls.
  return path
    .resolve(repoPath)
    .replace(/^\//, "")
    .replace(/\//g, "-")
    .replace(/\\/g, "-");
}

async function indexRepository(repoPath: string): Promise<{ ok: boolean; ms: number; reason?: string }> {
  const args = ["cli", "--json", "index_repository", JSON.stringify({ repo_path: repoPath })];
  const r = await runCli(args, 600_000);
  if (r.code !== 0) {
    return { ok: false, ms: r.ms, reason: r.stderr.split("\n").slice(-3).join(" ").slice(0, 200) };
  }
  return { ok: true, ms: r.ms };
}

async function tracePath(project: string, symbol: string): Promise<{ output: string; ms: number; code: number | null }> {
  const args = [
    "cli",
    "--json",
    "trace_path",
    JSON.stringify({ project, function_name: symbol }),
  ];
  const r = await runCli(args, 15_000);
  return { output: unwrapContent(r.stdout), ms: r.ms, code: r.code };
}

export async function runCmmBundle(repoPath: string, symbols: string[]): Promise<CmmRunResult> {
  if (!existsSync(CMM_BIN) && CMM_BIN !== "codebase-memory-mcp") {
    return { available: false, reason: `cmm binary not found at ${CMM_BIN}` };
  }
  // Sanity: --version probe.
  const versionProbe = await runCli(["--version"], 5_000);
  if (versionProbe.code !== 0) {
    return { available: false, reason: `cmm binary unusable: ${versionProbe.stderr.slice(0, 120)}` };
  }

  const idx = await indexRepository(repoPath);
  if (!idx.ok) {
    return { available: false, reason: `index_repository failed: ${idx.reason ?? "unknown"}` };
  }

  const project = projectIdFor(repoPath);

  const results: CmmQueryResult[] = [];
  for (const sym of symbols) {
    const { output, ms } = await tracePath(project, sym);
    results.push({
      symbol: sym,
      output,
      ms,
      tokens: approxTokens(output),
      tool: "trace_path",
    });
  }

  const lats = results.map((r) => r.ms);
  const toks = results.map((r) => r.tokens);
  return {
    available: true,
    index_ms: idx.ms,
    project,
    stats: {
      tool: "codebase-memory-mcp",
      latency: stats(lats),
      tokens_mean: toks.reduce((a, b) => a + b, 0) / Math.max(1, toks.length),
      tokens_p95: stats(toks).p95,
      resolved_tool: "trace_path",
    },
    results,
  };
}
