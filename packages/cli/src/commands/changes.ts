import type { Command } from "commander";
import kleur from "kleur";
import { changeSummary, formatChangeSummaryMarkdown } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  base?: string;
  head?: string;
  pr?: string;
  maxCommits?: string;
  json?: boolean;
}

export function registerChanges(program: Command): void {
  addRootOption(
    program
      .command("changes")
      .description("Summarize the current diff as files, touched symbols, commits, and PR references")
      .option("--base <ref>", "Diff base (default HEAD)", "HEAD")
      .option("--head <ref>", "Commit-range head for provenance (default HEAD)", "HEAD")
      .option("--pr <number>", "Summarize a GitHub PR diff instead of the working tree")
      .option("--max-commits <n>", "Max commits to include (default 20)")
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    try {
      const root = resolveRoot(opts);
      const maxCommits = opts.maxCommits ? Number(opts.maxCommits) : undefined;
      if (maxCommits !== undefined && (!Number.isInteger(maxCommits) || maxCommits < 1)) {
        throw new Error("--max-commits must be a positive integer");
      }
      const result = await changeSummary(root, {
        base: opts.base,
        head: opts.head,
        pr: opts.pr,
        max_commits: maxCommits,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.changed_files.length === 0) {
        console.log(kleur.dim("no dirty changes; changes has nothing to summarize"));
        return;
      }
      console.log(formatChangeSummaryMarkdown(result));
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}
