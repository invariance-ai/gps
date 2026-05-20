import type { Command } from "commander";
import kleur from "kleur";
import { appendDecision } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

export function registerDecide(program: Command): void {
  addRootOption(
    program
      .command("decide <symbol>")
      .description("Record a decision made about a symbol (choice + rejected alternative + rationale)")
      .requiredOption("--decision <text>", "The choice that was made")
      .option("--rejected <text>", "The alternative that was rejected (and why it lost)")
      .option("--rationale <text>", "Why this decision was made")
      .option("--made-by <name>", "Who made the decision")
      .option("--session <id>", "Session, PR, or conversation ID this came from")
      .option("--json", "Emit JSON"),
  ).action(
    async (
      symbol: string,
      opts: RootOption & {
        decision: string;
        rejected?: string;
        rationale?: string;
        madeBy?: string;
        session?: string;
        json?: boolean;
      },
    ) => {
      try {
        const result = await appendDecision(resolveRoot(opts), {
          symbol,
          decision: opts.decision,
          rejected_alternative: opts.rejected,
          rationale: opts.rationale,
          made_by: opts.madeBy,
          session: opts.session,
        });
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else
          console.log(
            `${kleur.green("recorded")} decision for ${kleur.bold(symbol)} → ${kleur.dim(result.file)}`,
          );
      } catch (e) {
        console.error(kleur.red(`error: ${(e as Error).message}`));
        process.exitCode = 1;
      }
    },
  );
}
