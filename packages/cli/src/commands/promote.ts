import type { Command } from "commander";
import kleur from "kleur";
import { findPromotionCandidates } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  min?: string;
  threshold?: string;
  json?: boolean;
}

export function registerPromote(program: Command): void {
  addRootOption(
    program
      .command("promote <symbol>")
      .description(
        "Find clusters of similar un-promoted notes that should become invariants",
      )
      .option("--min <n>", "Minimum cluster size", "3")
      .option("--threshold <f>", "Jaccard similarity threshold (0-1)", "0.4")
      .option("--json", "Emit JSON"),
  ).action(async (symbol: string, opts: Opts) => {
    const root = resolveRoot(opts);
    try {
      const min = Number.parseInt(opts.min ?? "3", 10);
      const threshold = Number.parseFloat(opts.threshold ?? "0.4");
      const candidates = await findPromotionCandidates(root, symbol, min, threshold);
      if (opts.json) {
        console.log(JSON.stringify(candidates, null, 2));
        return;
      }
      if (candidates.length === 0) {
        console.log(
          kleur.dim(
            `no promotion candidates for ${symbol} (need ≥${min} similar notes; tune --min / --threshold)`,
          ),
        );
        return;
      }
      console.log(kleur.bold(`Promotion candidates for ${symbol}:`));
      console.log("");
      for (const c of candidates) {
        console.log(
          `${kleur.cyan(c.representative_lesson)} ${kleur.dim(`(${c.notes.length} notes, severity hint: ${c.severity_hint})`)}`,
        );
        for (const n of c.notes) {
          console.log(kleur.dim(`  - [${n.severity}] ${n.lesson}`));
        }
        console.log("");
      }
      console.log(
        kleur.dim(
          "Hint: run `gps postmortem --pr <n>` to author a full invariant from a recent regression, or edit .gps/invariants.yml manually.",
        ),
      );
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}
