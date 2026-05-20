import type { Command } from "commander";
import kleur from "kleur";
import { brief, formatBriefMarkdown } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  base?: string;
  json?: boolean;
  maxSymbols?: string;
}

export function registerBrief(program: Command): void {
  addRootOption(
    program
      .command("brief")
      .description("Pre-finalize briefing: changed symbols + invariants + notes + tests + 'no tests' warnings. Call before declaring done.")
      .option("--base <ref>", "Diff base (default HEAD)", "HEAD")
      .option("--max-symbols <n>", "Cap symbols processed (default 20)")
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    try {
      const root = resolveRoot(opts);
      const maxSymbols = opts.maxSymbols ? Number(opts.maxSymbols) : undefined;
      if (maxSymbols !== undefined && (!Number.isInteger(maxSymbols) || maxSymbols < 1)) {
        throw new Error("--max-symbols must be a positive integer");
      }
      const result = await brief(root, { base: opts.base, max_symbols: maxSymbols });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = result.invariants.blocking_count > 0 ? 1 : 0;
        return;
      }

      if (result.changed_files.length === 0) {
        console.log(kleur.dim("no dirty changes; brief has nothing to do"));
        return;
      }

      console.log(formatBriefMarkdown(result));

      // Inline coloured warnings (markdown above stays neutral for piping to LLMs).
      if (result.untested_symbols.length > 0) {
        console.log(kleur.yellow(`⚠ ${result.untested_symbols.length} changed symbol(s) have no detected tests`));
      }
      if (result.invariants.blocking_count > 0) {
        console.log(kleur.red(`✗ ${result.invariants.blocking_count} blocking invariant violation(s) — resolve or waive before merge`));
        process.exitCode = 1;
      } else if (result.invariants.hits.length > 0) {
        console.log(kleur.yellow(`⚠ ${result.invariants.hits.length} non-blocking invariant(s) — read before merge`));
      }
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}
