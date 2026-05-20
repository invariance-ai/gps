import type { Command } from "commander";
import kleur from "kleur";
import { gateChanged, type GateHit } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  base?: string;
  json?: boolean;
}

export function registerReviewDiff(program: Command): void {
  addRootOption(
    program
      .command("review-diff")
      .description("Final-call invariant check: gate the dirty diff before declaring done")
      .option("--base <ref>", "Diff base (default HEAD)", "HEAD")
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    const result = await gateChanged(root, { base: opts.base });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.blocking.length > 0 ? 1 : 0;
      return;
    }

    if (result.changed_files.length === 0) {
      console.log(kleur.dim("no dirty changes; review-diff has nothing to do"));
      return;
    }
    console.log(
      kleur.bold("review-diff") +
        kleur.dim(`  ${result.changed_symbols.length} symbol(s) across ${result.changed_files.length} file(s) vs ${result.base}`),
    );
    if (result.hits.length === 0) {
      console.log(kleur.green("✓ no invariant violations in touched symbols"));
      return;
    }
    for (const h of result.hits) printHit(h);
    if (result.blocking.length > 0) {
      console.log(kleur.red(`\n✗ ${result.blocking.length} blocking — resolve or waive before merge`));
      process.exitCode = 1;
    } else {
      console.log(kleur.yellow(`\n⚠ ${result.hits.length} non-blocking invariant(s) — read before merge`));
    }
  });
}

function printHit(h: GateHit): void {
  const sev = h.invariant.severity;
  const tag =
    sev === "block" ? (h.waived ? kleur.yellow("WAIVED") : kleur.red("BLOCK")) :
    sev === "warn" ? kleur.yellow("WARN") : kleur.dim("INFO");
  console.log(`  ${tag}  ${kleur.cyan(h.invariant.name)} — ${h.invariant.rule}`);
  if (h.symbols.length) console.log(kleur.dim(`        symbols: ${h.symbols.join(", ")}`));
  if (h.waiver) console.log(kleur.dim(`        waiver: ${h.waiver.reason} (${h.waiver.at})`));
}
