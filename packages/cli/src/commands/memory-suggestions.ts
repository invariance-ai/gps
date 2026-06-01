import type { Command } from "commander";
import kleur from "kleur";
import { applyMemorySuggestions, memorySuggestionsForDiff } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  base?: string;
  pr?: string;
  limit?: number;
  evidence?: string;
  apply?: boolean;
  json?: boolean;
}

export function registerMemorySuggestions(program: Command): void {
  addRootOption(
    program
      .command("memory-suggestions")
      .description("Closeout memory queue for changed symbols")
      .option("--base <ref>", "Diff base", "HEAD")
      .option("--pr <number>", "Build suggestions from a GitHub PR diff instead of the working tree")
      .option("--limit <n>", "Max suggestions", (v) => parseInt(v, 10), 20)
      .option("--evidence <ref>", "Evidence tag for generated remember commands (default: diff:<base>)")
      .option("--apply", "Persist safe record-memory suggestions")
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    const result = await memorySuggestionsForDiff(root, {
      base: opts.base,
      pr: opts.pr,
      limit: opts.limit,
      evidence: opts.evidence,
    });
    const application = opts.apply ? await applyMemorySuggestions(root, result.suggestions) : undefined;
    if (opts.json) {
      console.log(JSON.stringify(application ? { ...result, application } : result, null, 2));
      return;
    }

    console.log(kleur.bold("memory suggestions"));
    if (result.pr) {
      console.log(kleur.dim(`PR #${result.pr.number}: ${result.pr.title}`));
    }
    console.log(
      kleur.dim(
        `${result.changed_symbol_count} changed symbol(s), ${result.changed_files.length} changed file(s) from ${result.source}:${result.base}`,
      ),
    );
    if (result.suggestions.length === 0) {
      console.log(kleur.green("no memory follow-ups for changed symbols"));
      return;
    }
    for (const s of result.suggestions) {
      const color = s.priority === "high" ? kleur.red : s.priority === "medium" ? kleur.yellow : kleur.dim;
      console.log(`- ${color(`[${s.priority}]`)} ${kleur.bold(s.symbol)} ${kleur.dim(s.file)}`);
      console.log(`  ${s.reason}`);
      console.log(`  ${kleur.cyan(s.command)}`);
    }
    if (application) {
      console.log(kleur.green(`\napplied ${application.applied.length} memory suggestion(s)`));
      for (const item of application.applied) {
        console.log(`  ${kleur.green("✓")} ${item.suggestion.symbol} ${kleur.dim(item.result.path)}`);
      }
      if (application.skipped.length > 0) {
        console.log(kleur.dim(`skipped ${application.skipped.length} non-record suggestion(s)`));
      }
    }
  });
}
