import type { Command } from "commander";
import kleur from "kleur";
import { appendNote } from "@invariance/gps-core";
import type { NoteSeverity, NoteSource } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

export function registerLearn(program: Command): void {
  addRootOption(
    program
      .command("learn <symbol>")
      .description("Record a lesson learned about a symbol (anchored memory)")
      .requiredOption("--lesson <text>", "The lesson to record")
      .option("--severity <level>", "low | medium | high", "medium")
      .option(
        "--evidence <ref>",
        "PR ID, doc path, commit, incident — what backs this lesson",
      )
      .option("--source <s>", "agent | human | doc | git | promoted | todo", "human")
      .option("--json", "Emit JSON"),
  ).action(
    async (
      symbol: string,
      opts: RootOption & {
        lesson: string;
        severity: string;
        evidence?: string;
        source: string;
        json?: boolean;
      },
    ) => {
      try {
        const result = await appendNote(resolveRoot(opts), {
          symbol,
          lesson: opts.lesson,
          evidence: opts.evidence,
          severity: opts.severity as NoteSeverity,
          source: opts.source as NoteSource,
        });
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else
          console.log(
            `${kleur.green("recorded")} note for ${kleur.bold(symbol)} → ${kleur.dim(result.file)}`,
          );
      } catch (e) {
        console.error(kleur.red(`error: ${(e as Error).message}`));
        process.exitCode = 1;
      }
    },
  );
}
