/**
 * Accuracy harness: judges whether a tool's output is *sufficient* to answer
 * a structural question about a symbol. Uses `claude -p` as the LLM judge so
 * the bench is reproducible without an API key configured in env.
 *
 * For each symbol we ask three category questions (a coding agent would
 * realistically need these answered before editing):
 *
 *   Q1. "What functions call <symbol>?"           — callers recall
 *   Q2. "What functions does <symbol> call?"      — callees recall
 *   Q3. "Which tests cover <symbol>?"             — test linkage
 *
 * Ground truth comes from GPS's own structural index (treated as the oracle
 * for callers/callees because it parses the AST). For tests, ground truth is
 * the GPS testsForSymbol result. We then ask claude -p to extract the answer
 * set from each tool's output and score recall against the oracle.
 *
 * This is intentionally asymmetric in GPS's favour for callers/callees (GPS
 * is the oracle), but the *interesting* number is whether rg and cmm can
 * also recover those answers — and at what token cost. The goal is to show
 * GPS delivers the same answer for far fewer tokens, not that GPS "knows"
 * more.
 */
import { spawn } from "node:child_process";
import {
  open,
  getContext,
  resolveSymbol,
  callersOf,
  calleesOf,
  testsForSymbol,
} from "@invariance/gps-core";

export interface OracleAnswer {
  symbol: string;
  callers: string[];
  callees: string[];
  tests: string[];
}

export async function buildOracle(cwd: string, symbols: string[]): Promise<OracleAnswer[]> {
  const ctx = await open(cwd);
  const out: OracleAnswer[] = [];
  for (const symName of symbols) {
    const sym = resolveSymbol(symName, ctx);
    if (!sym) continue;
    const callers = callersOf(sym, ctx).map((s) => s.name);
    const callees = calleesOf(sym, ctx).map((s) => s.name);
    const tests = (await testsForSymbol(sym.name, sym.file, ctx.root, ctx.index)).map(
      (t) => t.file,
    );
    out.push({ symbol: symName, callers, callees, tests });
  }
  return out;
}

export interface ToolOutput {
  symbol: string;
  tool: string;
  text: string;
}

export interface QuestionScore {
  symbol: string;
  tool: string;
  category: "callers" | "callees" | "tests";
  oracle: string[];
  extracted: string[];
  recall: number;
}

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p", "--output-format", "text"], {
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve("");
    }, 60_000);
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (!stdout && stderr) {
        // Surface the error once so debugging is possible.
        process.stderr.write(`claude -p stderr: ${stderr.slice(0, 200)}\n`);
      }
      resolve(stdout.trim());
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function buildPrompt(symbol: string, category: string, toolOutput: string): string {
  const ask =
    category === "callers"
      ? `What functions call \`${symbol}\`?`
      : category === "callees"
        ? `What functions does \`${symbol}\` call?`
        : `Which test files cover \`${symbol}\`?`;
  return `You are extracting structural facts from tool output. Be conservative — only list items you can support from the output below.

Question: ${ask}

Tool output:
"""
${toolOutput.slice(0, 8000)}
"""

Respond with ONLY a JSON array of strings, e.g. ["foo", "bar"]. No prose. Empty array if the output doesn't answer the question.`;
}

function parseList(raw: string): string[] {
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[0]);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    /* fall through */
  }
  return [];
}

function recallAt(oracle: string[], extracted: string[]): number {
  if (oracle.length === 0) return extracted.length === 0 ? 1 : 1;
  const oracleSet = new Set(oracle.map((s) => s.toLowerCase()));
  const got = new Set(
    extracted
      .map((s) => s.toLowerCase())
      .flatMap((s) => [s, s.split(/[/\\.]/).pop() ?? s]),
  );
  let hits = 0;
  for (const o of oracleSet) {
    if (got.has(o) || [...got].some((g) => g.includes(o) || o.includes(g))) hits += 1;
  }
  return hits / oracleSet.size;
}

export async function scoreTool(
  oracle: OracleAnswer[],
  outputs: ToolOutput[],
): Promise<QuestionScore[]> {
  const byKey = new Map<string, ToolOutput>();
  for (const o of outputs) byKey.set(`${o.tool}::${o.symbol}`, o);
  const scores: QuestionScore[] = [];
  for (const ans of oracle) {
    for (const tool of new Set(outputs.map((o) => o.tool))) {
      const out = byKey.get(`${tool}::${ans.symbol}`);
      if (!out) continue;
      for (const cat of ["callers", "callees", "tests"] as const) {
        const oracleSet = ans[cat];
        const prompt = buildPrompt(ans.symbol, cat, out.text);
        const reply = await runClaude(prompt);
        const extracted = parseList(reply);
        scores.push({
          symbol: ans.symbol,
          tool,
          category: cat,
          oracle: oracleSet,
          extracted,
          recall: recallAt(oracleSet, extracted),
        });
      }
    }
  }
  return scores;
}

export interface ToolAccuracySummary {
  tool: string;
  callers_recall: number;
  callees_recall: number;
  tests_recall: number;
  overall_recall: number;
}

export function summarize(scores: QuestionScore[]): ToolAccuracySummary[] {
  const byTool = new Map<string, QuestionScore[]>();
  for (const s of scores) {
    const list = byTool.get(s.tool) ?? [];
    list.push(s);
    byTool.set(s.tool, list);
  }
  const out: ToolAccuracySummary[] = [];
  for (const [tool, list] of byTool) {
    const mean = (cat: "callers" | "callees" | "tests"): number => {
      const xs = list.filter((s) => s.category === cat).map((s) => s.recall);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    };
    const callers = mean("callers");
    const callees = mean("callees");
    const tests = mean("tests");
    out.push({
      tool,
      callers_recall: callers,
      callees_recall: callees,
      tests_recall: tests,
      overall_recall: (callers + callees + tests) / 3,
    });
  }
  return out;
}

export async function getContextOutput(cwd: string, symbol: string): Promise<string> {
  const ctx = await open(cwd);
  const r = await getContext(
    {
      symbol,
      depth: 2,
      strands: ["structural", "tests", "provenance", "invariants"],
      mode: "brief",
      budget: 1500,
    },
    ctx,
  ).catch(() => null);
  return r ? JSON.stringify(r, null, 2) : "";
}

export async function isClaudeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["--version"]);
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 5_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
