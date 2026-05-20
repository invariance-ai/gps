import type { Command } from "commander";
import kleur from "kleur";
import { findRejectedConflicts } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  proposed: string;
  symbol?: string;
  threshold: number;
  json?: boolean;
  failOnConflict?: boolean;
}

export function registerCheckProposal(program: Command): void {
  addRootOption(
    program
      .command("check-proposal")
      .description("Detect when a proposal matches a previously rejected alternative")
      .requiredOption("--proposed <text>", "The proposed change description")
      .option("--symbol <name>", "Restrict to one symbol's decisions")
      .option("--threshold <n>", "Jaccard similarity threshold (0-1)", (v) => parseFloat(v), 0.25)
      .option("--fail-on-conflict", "Exit 1 if a conflict is found")
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    const conflicts = await findRejectedConflicts(root, opts.proposed, {
      symbol: opts.symbol,
      threshold: opts.threshold,
    });
    if (opts.json) {
      console.log(JSON.stringify({ proposed: opts.proposed, conflicts }, null, 2));
      if (opts.failOnConflict && conflicts.length > 0) process.exitCode = 1;
      return;
    }
    if (conflicts.length === 0) {
      console.log(kleur.green(`✓ no prior rejected alternative matches`));
      return;
    }
    console.log(kleur.red(`✗ ${conflicts.length} prior decision(s) reject this approach:`));
    for (const c of conflicts) {
      console.log("");
      console.log(`  ${kleur.bold("Conflict with prior decision:")}  ${kleur.dim(`(sim ${c.similarity})`)}`);
      console.log(`    Proposed:            ${c.proposed}`);
      console.log(`    Rejected previously: ${c.rejected_alternative}`);
      console.log(`    Decision:            ${c.prior_decision}`);
      if (c.rationale) console.log(`    Rationale:           ${c.rationale}`);
      console.log(kleur.dim(`    on ${c.symbol} @ ${c.recorded_at.slice(0, 10)}`));
    }
    if (opts.failOnConflict) process.exitCode = 1;
  });
}
