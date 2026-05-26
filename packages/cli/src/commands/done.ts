import type { Command } from "commander";
import kleur from "kleur";
import {
  auditSession,
  hardSearchSuggestionsForActiveSession,
  learnedTestCommandsForSymbol,
  readObservations,
  repeatedMistakePatterns,
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  symbol?: string;
  json?: boolean;
}

export function registerDone(program: Command): void {
  addRootOption(
    program
      .command("done")
      .description("Post-edit self-audit: tests, invariants, durable memory, learned commands")
      .option("--symbol <name>", "Symbol to include learned commands for")
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    const observations = await readObservations(root).catch(() => undefined);
    const symbol = opts.symbol ?? observations?.last_prepared_symbol;
    const [audit, hardSearch, patterns, commands] = await Promise.all([
      auditSession(root),
      hardSearchSuggestionsForActiveSession(root),
      repeatedMistakePatterns(root),
      symbol ? learnedTestCommandsForSymbol(root, symbol) : Promise.resolve([]),
    ]);
    const result = { audit, hard_search: hardSearch, mistake_patterns: patterns.slice(0, 10), learned_test_commands: commands };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = audit.checks.every((c) => c.pass) ? 0 : 1;
      return;
    }
    console.log(kleur.bold("post-edit audit"));
    for (const c of audit.checks) {
      const tag = c.pass ? kleur.green("✓") : kleur.red("✗");
      console.log(`  ${tag} ${kleur.cyan(c.id)}  ${kleur.dim(c.detail)}`);
    }
    if (commands.length > 0) {
      console.log("\nLearned test command:");
      for (const c of commands) console.log(`  ${kleur.green("✓")} \`${c.command}\` ${kleur.dim(`${c.pass_count} pass(es)`)}`);
    }
    if (patterns.length > 0) {
      console.log("\nRepeated failure patterns:");
      for (const p of patterns.slice(0, 5)) console.log(`  ${kleur.yellow("!")} ${p.symbol}: ${p.message} ${kleur.dim(`${p.count}x`)}`);
    }
    if (hardSearch.length > 0) {
      console.log("\nSearch memory candidate:");
      for (const h of hardSearch) console.log(`  ${kleur.yellow("!")} ${h.suggestion}`);
    }
    const failed = audit.checks.filter((c) => !c.pass).length;
    if (failed > 0) process.exitCode = 1;
  });
}
