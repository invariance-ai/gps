import type { Command } from "commander";
import kleur from "kleur";
import { resume } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface ResumeOpts extends RootOption {
  json?: boolean;
}

export function registerResume(program: Command): void {
  addRootOption(
    program
      .command("resume")
      .description(
        "\"Where was I?\" — surface TODOs, open questions, and recent decisions for " +
        "files in the current git diff. Prints a concise markdown brief by default.",
      )
      .option("--json", "Emit structured JSON instead of markdown"),
  ).action(async (opts: ResumeOpts) => {
    const root = resolveRoot(opts);

    let result;
    try {
      result = await resume(root);
    } catch (err) {
      console.error(kleur.red(`resume failed: ${(err as Error).message}`));
      process.exitCode = 1;
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(result.markdown);
  });
}
