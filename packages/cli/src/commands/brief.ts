import type { Command } from "commander";
import kleur from "kleur";
import { brief, formatBriefMarkdown, estimateTokens } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  base?: string;
  json?: boolean;
  maxSymbols?: string;
  tokens?: boolean;
  cost?: boolean;
}

export function registerBrief(program: Command): void {
  addRootOption(
    program
      .command("brief")
      .description("Pre-finalize briefing: changed symbols + invariants + notes + tests + 'no tests' warnings. Call before declaring done.")
      .option("--base <ref>", "Diff base (default HEAD)", "HEAD")
      .option("--max-symbols <n>", "Cap symbols processed (default 20)")
      .option("--tokens", "Print estimated token cost of the brief")
      .option("--cost", "Alias for --tokens")
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    try {
      const root = resolveRoot(opts);
      const maxSymbols = opts.maxSymbols ? Number(opts.maxSymbols) : undefined;
      if (maxSymbols !== undefined && (!Number.isInteger(maxSymbols) || maxSymbols < 1)) {
        throw new Error("--max-symbols must be a positive integer");
      }
      const result = await brief(root, { base: opts.base, max_symbols: maxSymbols });
      const showTokens = !!(opts.tokens || opts.cost);
      const tokenFooter = () =>
        kleur.dim(`\n~${estimateTokens(formatBriefMarkdown(result))} tokens`);

      if (opts.json) {
        const out = showTokens
          ? { ...result, tokens: { estimated: estimateTokens(formatBriefMarkdown(result)) } }
          : result;
        console.log(JSON.stringify(out, null, 2));
        process.exitCode = result.invariants.blocking_count > 0 ? 1 : 0;
        return;
      }

      if (result.changed_files.length === 0) {
        console.log(kleur.dim("no dirty changes; brief has nothing to do"));
        return;
      }

      if (!result.source_changes) {
        // Files changed but none map to indexed source symbols (only .gps/,
        // docs, config, etc.). Print one explicit status line — not empty
        // Invariants/Notes/Tests sections that look like a clean pass. Exit 0.
        console.log(formatBriefMarkdown(result).trimEnd());
        if (showTokens) console.log(tokenFooter());
        return;
      }

      console.log(formatBriefMarkdown(result));
      if (showTokens) console.log(tokenFooter());

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
