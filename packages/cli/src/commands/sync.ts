import type { Command } from "commander";
import kleur from "kleur";
import { syncGps } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface SyncOpts extends RootOption {
  remote?: string;
  branch?: string;
  push?: boolean;
  json?: boolean;
}

export function registerSync(program: Command): void {
  addRootOption(
    program
      .command("sync")
      .description("Fetch + merge .gps/ from the repo's git remote; dedupe notes/decisions by id")
      .option("--remote <name>", "Git remote (default origin)", "origin")
      .option("--branch <name>", "Branch (default current)")
      .option("--push", "Push after merging", false)
      .option("--json", "Emit JSON"),
  ).action(async (opts: SyncOpts) => {
    const root = resolveRoot(opts);
    const result = await syncGps(root, {
      remote: opts.remote,
      branch: opts.branch,
      push: opts.push,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const head = `${result.pulled ? kleur.green("pulled") : kleur.dim("not pulled")} · ${result.pushed ? kleur.green("pushed") : kleur.dim("not pushed")}`;
    console.log(head);
    console.log(kleur.dim(`merged_notes=${result.merged_notes} merged_decisions=${result.merged_decisions}`));
    if (result.conflicts.length) {
      console.log(kleur.yellow(`\nresolved ${result.conflicts.length} .gps/ conflict file(s):`));
      for (const f of result.conflicts) console.log(`  • ${f}`);
    }
  });
}
