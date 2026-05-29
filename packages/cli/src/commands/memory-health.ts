import type { Command } from "commander";
import kleur from "kleur";
import { memoryHealth } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  days: number;
  limit: number;
  base?: string;
  noDiff?: boolean;
  json?: boolean;
}

export function registerMemoryHealth(program: Command): void {
  addRootOption(
    program
      .command("memory-health")
      .description("Repo memory health score and maintenance actions")
      .option("--days <n>", "Staleness threshold in days", (value) => parseInt(value, 10), 90)
      .option("--limit <n>", "Max recommendations", (value) => parseInt(value, 10), 10)
      .option("--base <ref>", "Diff base for changed-symbol memory suggestions", "HEAD")
      .option("--no-diff", "Skip changed-symbol memory suggestions")
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    const result = await memoryHealth(root, {
      days: opts.days,
      limit: opts.limit,
      base: opts.base,
      includeDiff: !opts.noDiff,
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const pct = `${Math.round(result.score * 100)}%`;
    const tone = result.status === "healthy" ? kleur.green : result.status === "watch" ? kleur.yellow : kleur.red;
    console.log(kleur.bold("memory health") + `  ${tone(`${result.status} ${pct}`)}`);
    console.log(
      kleur.dim(
        [
          `${result.counts.symbol_notes + result.counts.scoped_notes} notes`,
          `${result.counts.invariants} invariants`,
          `${result.counts.decisions} decisions`,
          `${result.counts.preferences} preferences`,
          `${result.counts.inbox_pending} inbox`,
        ].join(", "),
      ),
    );
    console.log(
      kleur.dim(
        [
          `${result.counts.review_items} review`,
          `${result.counts.validation_issues} validation`,
          `${result.counts.prunable} prunable`,
          `${result.counts.diff_suggestions} diff suggestions`,
        ].join(", "),
      ),
    );
    if (result.recommendations.length === 0) {
      console.log(kleur.green("no memory maintenance actions"));
      return;
    }
    console.log(kleur.cyan("\nRecommended actions:"));
    for (const rec of result.recommendations) {
      const color = rec.priority === "high" ? kleur.red : rec.priority === "medium" ? kleur.yellow : kleur.dim;
      console.log(`  ${color(`[${rec.priority}]`)} ${rec.reason}`);
      console.log(`    ${kleur.cyan(rec.command)}`);
    }
  });
}
