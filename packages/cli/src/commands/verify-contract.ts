import type { Command } from "commander";
import kleur from "kleur";
import { buildContract, saveContract, verifyContract } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface BuildOpts extends RootOption {
  intent: string;
  json?: boolean;
}

interface VerifyOpts extends RootOption {
  diff?: boolean;
  base: string;
  json?: boolean;
}

export function registerVerifyContract(program: Command): void {
  addRootOption(
    program
      .command("contract-build <symbol>")
      .description("Build & save an edit contract for a symbol")
      .option("--intent <text>", "What you plan to change", "(unspecified)")
      .option("--json", "Emit JSON"),
  ).action(async (symbol: string, opts: BuildOpts) => {
    const root = resolveRoot(opts);
    try {
      const c = await buildContract(root, { symbol, intent: opts.intent });
      await saveContract(root, c);
      if (opts.json) {
        console.log(JSON.stringify(c, null, 2));
        return;
      }
      console.log(kleur.bold(`contract for ${c.symbol}`));
      console.log(kleur.dim(`  intent: ${c.intent}`));
      console.log(kleur.cyan(`\nAllowed files (${c.allowed_files.length}):`));
      for (const f of c.allowed_files.slice(0, 10)) console.log(`  ${f}`);
      console.log(kleur.cyan(`\nAllowed symbols (${c.allowed_symbols.length}):`));
      for (const s of c.allowed_symbols.slice(0, 10)) console.log(`  ${s}`);
      if (c.invariants.length) {
        console.log(kleur.cyan(`\nInvariants:`));
        for (const i of c.invariants) console.log(`  ${kleur.dim(`[${i.severity}]`)} ${i.name}: ${i.rule}`);
      }
      if (c.required_tests.length) {
        console.log(kleur.cyan(`\nRequired tests:`));
        for (const t of c.required_tests) console.log(`  ${t}`);
      }
      if (c.blockers.length) {
        console.log(kleur.red(`\nBlocking invariants: ${c.blockers.join(", ")}`));
      }
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });

  addRootOption(
    program
      .command("verify-contract")
      .description("Check the working diff against the last saved edit contract")
      .option("--diff", "Verify against the working-tree diff", true)
      .option("--base <ref>", "Diff base (default HEAD)", "HEAD")
      .option("--json", "Emit JSON"),
  ).action(async (opts: VerifyOpts) => {
    const root = resolveRoot(opts);
    const r = await verifyContract(root, opts.base);
    if (!r) {
      console.error(kleur.red("no contract found — run `gps contract-build <symbol>` first"));
      process.exitCode = 1;
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      process.exitCode = r.violations.length > 0 ? 1 : 0;
      return;
    }
    console.log(kleur.bold(`contract: ${r.contract.symbol} (${r.contract.intent})`));
    console.log(kleur.dim(`  ${r.diff_files.length} file(s), ${r.diff_symbols.length} symbol(s) in diff`));
    if (r.violations.length === 0) {
      console.log(kleur.green(`✓ diff stays within contract`));
      return;
    }
    console.log(kleur.red(`\n✗ ${r.violations.length} violation(s):`));
    for (const v of r.violations) {
      console.log(`  ${kleur.yellow(v.type)}  ${v.detail}`);
    }
    process.exitCode = 1;
  });
}
