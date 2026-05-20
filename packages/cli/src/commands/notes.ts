import type { Command } from "commander";
import kleur from "kleur";
import { loadNotes, loadAllNotes, rankNotes } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

export function registerNotes(program: Command): void {
  addRootOption(
    program
      .command("notes [symbol]")
      .description("List notes attached to a symbol (or all)")
      .option("--all", "List every note across every symbol")
      .option("--include-promoted", "Include notes already lifted to invariants")
      .option("--json", "Emit JSON"),
  ).action(
    async (
      symbol: string | undefined,
      opts: RootOption & { all?: boolean; includePromoted?: boolean; json?: boolean },
    ) => {
      const root = resolveRoot(opts);
      try {
        const notes =
          opts.all || !symbol ? await loadAllNotes(root) : await loadNotes(root, symbol);
        const filtered = rankNotes(notes, Number.POSITIVE_INFINITY, !!opts.includePromoted);
        if (opts.json) {
          console.log(JSON.stringify(filtered, null, 2));
          return;
        }
        if (filtered.length === 0) {
          console.log(kleur.dim(symbol ? `no notes for ${symbol}` : "no notes yet"));
          return;
        }
        for (const n of filtered) {
          const tag = kleur.dim(`[${n.severity}]`);
          console.log(`${kleur.bold(n.symbol)} ${tag} ${n.lesson}`);
          const meta = [
            n.evidence && `evidence: ${n.evidence}`,
            `source: ${n.source}`,
            `recorded: ${n.recorded_at.slice(0, 10)}`,
          ]
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
