import type { Command } from "commander";
import kleur from "kleur";
import { memoryGraph, type RecallKind } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface MemoryGraphOpts extends RootOption {
  limit: number;
  kind?: string;
  relatedLimit?: number;
  symbolLimit?: number;
  symbols?: boolean;
  noIssues?: boolean;
  staleDays?: number;
  json?: boolean;
}

const KINDS: RecallKind[] = ["note", "decision", "invariant", "preference", "lesson", "question", "assumption", "todo"];

function parseKinds(raw?: string): RecallKind[] | undefined {
  if (!raw) return undefined;
  const wanted = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = wanted.filter((k) => !(KINDS as string[]).includes(k));
  if (bad.length) throw new Error(`unknown --kind value(s): ${bad.join(", ")} (valid: ${KINDS.join(", ")})`);
  return wanted.length ? (wanted as RecallKind[]) : undefined;
}

export function registerMemoryGraph(program: Command): void {
  addRootOption(
    program
      .command("memory-graph <query>")
      .description("Build a topic-centered graph of recalled memory and related symbols")
      .option("--limit <n>", "Max memory hits", (v) => parseInt(v, 10), 20)
      .option("--kind <list>", `Restrict to comma-separated kinds (${KINDS.join(",")})`)
      .option("--related-limit <n>", "Max related symbols per memory hit", (v) => parseInt(v, 10), 8)
      .option("--symbol-limit <n>", "Max topic-matching symbols to seed when an index exists", (v) => parseInt(v, 10), 5)
      .option("--no-symbols", "Only include symbols reached from recalled memory")
      .option("--no-issues", "Skip stale/conflict checks for graph symbols")
      .option("--stale-days <n>", "Age threshold for stale memory issues", (v) => parseInt(v, 10), 90)
      .option("--json", "Emit JSON"),
  ).action(async (query: string, opts: MemoryGraphOpts) => {
    try {
      const root = resolveRoot(opts);
      const graph = await memoryGraph(root, query, {
        limit: opts.limit,
        kinds: parseKinds(opts.kind),
        relatedLimit: opts.relatedLimit,
        includeSymbols: opts.symbols !== false,
        symbolLimit: opts.symbolLimit,
        includeIssues: !opts.noIssues,
        staleDays: opts.staleDays,
      });
      if (opts.json) {
        console.log(JSON.stringify(graph, null, 2));
        return;
      }
      console.log(kleur.bold(`memory graph: "${query}"`));
      console.log(
        kleur.dim(
          `${graph.summary.memory_nodes} memory nodes, ${graph.summary.symbol_nodes} symbol nodes, ${graph.summary.edges} edges, ${graph.summary.issues.total} issues`,
        ),
      );
      if (graph.summary.central_symbols.length > 0) {
        console.log(kleur.cyan("\ncentral symbols"));
        for (const s of graph.summary.central_symbols) {
          const loc = s.file ? `${s.file}:${s.line ?? 0}` : "";
          console.log(
            `- ${kleur.bold(s.symbol)} ${kleur.dim(loc)} ${kleur.dim(`degree ${s.degree}, memory ${s.memory_count}, issues ${s.issue_count}`)}`,
          );
        }
      }
      if (graph.recommendations.length > 0) {
        console.log(kleur.cyan("\nrecommendations"));
        for (const r of graph.recommendations) {
          const color = r.priority === "high" ? kleur.red : r.priority === "medium" ? kleur.yellow : kleur.dim;
          console.log(`- ${color(`[${r.priority}]`)} ${r.reason}`);
          console.log(`  ${kleur.dim(r.command)}`);
        }
      }
      for (const n of graph.nodes) {
        if (n.type === "memory") {
          console.log(`- ${kleur.cyan(n.id)} ${kleur.bold(n.label)} ${kleur.dim(`score ${n.score ?? 0}`)}`);
          if (n.text) console.log(`  ${n.text}`);
        } else {
          const loc = n.file ? `${n.file}:${n.line ?? 0}` : "";
          console.log(`- ${kleur.green(n.id)} ${n.label} ${kleur.dim(loc)}`);
        }
      }
      if (graph.edges.length > 0) {
        console.log(kleur.cyan("\nedges"));
        for (const e of graph.edges) console.log(`- ${e.from} -[${e.type}]-> ${e.to}`);
      }
      if (graph.issues.length > 0) {
        console.log(kleur.cyan("\nissues"));
        for (const i of graph.issues) {
          const color = i.severity === "block" ? kleur.red : i.severity === "warn" ? kleur.yellow : kleur.dim;
          console.log(`- ${color(`[${i.severity}]`)} ${i.symbol}: ${i.summary}`);
          console.log(`  ${kleur.dim(i.command)}`);
        }
      }
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}
