import type { Command } from "commander";
import kleur from "kleur";
import { loadDecisions, loadAllDecisions, rankDecisions } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

export function registerDecisions(program: Command): void {
  addRootOption(
    program
      .command("decisions [symbol]")
      .description("List decisions recorded for a symbol (or all)")
      .option("--all", "List every decision")
      .option("--json", "Emit JSON"),
  ).action(
    async (
      symbol: string | undefined,
      opts: RootOption & { all?: boolean; json?: boolean },
    ) => {
      const root = resolveRoot(opts);
      try {
        const decisions =
          opts.all || !symbol
            ? await loadAllDecisions(root)
            : await loadDecisions(root, symbol);
        const ranked = rankDecisions(decisions, Number.POSITIVE_INFINITY);
        if (opts.json) {
          console.log(JSON.stringify(ranked, null, 2));
          return;
        }
        if (ranked.length === 0) {
          console.log(kleur.dim(symbol ? `no decisions for ${symbol}` : "no decisions yet"));
          return;
        }
        for (const d of ranked) {
          console.log(`${kleur.bold(d.symbol)} ${kleur.dim(d.recorded_at.slice(0, 10))}`);
          console.log(`  ${d.decision}`);
          if (d.rejected_alternative)
            console.log(kleur.dim(`  rejected: ${d.rejected_alternative}`));
          if (d.rationale) console.log(kleur.dim(`  rationale: ${d.rationale}`));
          const meta = [d.made_by && `by ${d.made_by}`, d.session && `from ${d.session}`]
            .filter(Boolean)
            .join("  ");
          if (meta) console.log(kleur.dim(`  ${meta}`));
        }
      } catch (e) {
        console.error(kleur.red(`error: ${(e as Error).message}`));
        process.exitCode = 1;
      }
    },
  );
}
