import type { Command } from "commander";
import kleur from "kleur";
import { appendWaiver, loadInvariants } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface WaiveOpts extends RootOption {
  reason: string;
  by?: string;
}

export function registerWaive(program: Command): void {
  addRootOption(
    program
      .command("waive <invariant>")
      .description("Record an auditable waiver for a blocking invariant")
      .requiredOption("--reason <text>", "Why this exception is intentional")
      .option("--by <author>", "Who is recording the waiver"),
  ).action(async (invariant: string, opts: WaiveOpts) => {
    const root = resolveRoot(opts);
    const all = await loadInvariants(root);
    if (!all.some((i) => i.name === invariant)) {
      console.error(kleur.red(`error: unknown invariant "${invariant}"`));
      console.error(kleur.dim(`known: ${all.map((i) => i.name).join(", ") || "(none)"}`));
      process.exitCode = 1;
      return;
    }
    const w = await appendWaiver(root, { invariant, reason: opts.reason, by: opts.by });
    console.log(kleur.green(`✓ waiver recorded for ${kleur.cyan(invariant)} at ${w.at}`));
  });
}
