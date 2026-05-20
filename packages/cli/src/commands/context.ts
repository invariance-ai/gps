import type { Command } from "commander";
import kleur from "kleur";
import {
  getContext,
  formatContextPretty,
  formatContextMarkdown,
  featureContext,
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface ContextOpts extends RootOption {
  json?: boolean;
  markdown?: boolean;
  depth: number;
  since?: string;
  authoredBy?: string;
  feature?: string;
  mode?: "brief" | "full";
  budget?: number;
}

export function registerContext(program: Command): void {
  addRootOption(
    program
      .command("context [symbol]")
      .description("Full multi-strand context for a symbol — or a whole feature")
      .option("--json", "Emit JSON (best for tool chaining)")
      .option("--markdown", "Emit markdown (best for piping into an LLM)")
      .option("--depth <n>", "Caller/callee depth", (v) => parseInt(v, 10), 2)
      .option("--since <when>", "Drop notes/decisions/provenance older than this (ISO or 7d/2w/3mo)")
      .option("--authored-by <name>", "Filter decisions + provenance to one author")
      .option("--feature <label>", "Aggregate context for a feature instead of a symbol")
      .option("--mode <mode>", "brief|full payload (default brief)", "brief")
      .option("--budget <n>", "Token budget (default 1500; 0 = unlimited)", (v) => parseInt(v, 10), 1500),
  ).action(async (symbol: string | undefined, opts: ContextOpts) => {
    const root = resolveRoot(opts);
    try {
      if (opts.feature) {
        const fc = await featureContext(root, opts.feature);
        if (opts.json) {
          console.log(JSON.stringify(fc, null, 2));
          return;
        }
        console.log(kleur.bold(`feature: ${fc.feature}`));
        console.log(kleur.cyan(`\nTop symbols (${fc.top_symbols.length}):`));
        for (const s of fc.top_symbols.slice(0, 8)) {
          console.log(`  ${s.weight.toFixed(2)}  ${kleur.cyan(s.id)}`);
        }
        if (fc.invariants.length > 0) {
          console.log(kleur.cyan(`\nInvariants (${fc.invariants.length}):`));
          for (const r of fc.invariants.slice(0, 5)) {
            console.log(`  ${kleur.cyan(r.invariant.name)} ${kleur.dim(`[${r.invariant.severity}]`)} — ${r.invariant.rule}`);
          }
        }
        if (fc.recent_decisions.length > 0) {
          console.log(kleur.cyan(`\nRecent decisions:`));
          for (const d of fc.recent_decisions) console.log(`  ${kleur.dim(d.recorded_at.slice(0, 10))}  ${d.symbol}  ${kleur.dim(d.decision.slice(0, 80))}`);
        }
        if (fc.open_questions.length > 0) {
          console.log(kleur.cyan(`\nOpen questions:`));
          for (const q of fc.open_questions) console.log(`  ${q.symbol}  ${q.question}`);
        }
        if (fc.common_tests.length > 0) {
          console.log(kleur.cyan(`\nTests touched most often:`));
          for (const t of fc.common_tests) console.log(`  ${t.file} ${kleur.dim(`(${t.failures}/${t.runs} fail)`)}`);
        }
        return;
      }

      if (!symbol) throw new Error("symbol is required (or pass --feature <label>)");
      const r = await getContext(
        {
          symbol,
          depth: opts.depth,
          strands: ["structural", "tests", "provenance", "invariants"],
          since: opts.since,
          authored_by: opts.authoredBy,
          mode: opts.mode ?? "brief",
          budget: opts.budget ?? 1500,
        },
        root,
      );
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      else if (opts.markdown) console.log(formatContextMarkdown(r));
      else console.log(formatContextPretty(r));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(kleur.red(`error: ${msg}`));
      if (msg.includes("ENOENT") || msg.includes("symbols.json")) {
        console.error(kleur.dim(`hint: run ${kleur.bold("gps init && gps index")} first.`));
      }
      process.exitCode = 1;
    }
  });
}
