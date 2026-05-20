import type { Command } from "commander";
import kleur from "kleur";
import {
  open as openQuery,
  resolveSymbol,
  testsForSymbol,
  formatTestsPretty,
  diffSymbols,
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface TestsOpts extends RootOption {
  json?: boolean;
  diff?: boolean;
  base: string;
}

export function registerTests(program: Command): void {
  addRootOption(
    program
      .command("tests [symbol]")
      .description("Tests likely to cover a symbol — or every symbol in the diff")
      .option("--json", "Emit JSON instead of pretty output")
      .option("--diff", "List tests for every symbol in the working-tree diff")
      .option("--base <ref>", "Diff base (default HEAD)", "HEAD"),
  ).action(async (symbol: string | undefined, opts: TestsOpts) => {
    const root = resolveRoot(opts);
    try {
      if (opts.diff) {
        const { base, symbols } = await diffSymbols(root, opts.base);
        if (symbols.length === 0) {
          if (opts.json) console.log(JSON.stringify({ base, results: [] }, null, 2));
          else console.log(kleur.dim(`no indexed symbols in diff vs ${base}`));
          return;
        }
        const ctx = await openQuery(root);
        const results: Array<{ symbol: string; file: string; tests: Awaited<ReturnType<typeof testsForSymbol>> }> = [];
        for (const s of symbols) {
          const id = s.qualified_name ?? s.name;
          const tests = await testsForSymbol(s.name, s.file, root, ctx.index);
          if (tests.length === 0) continue;
          results.push({ symbol: id, file: s.file, tests });
        }
        if (opts.json) {
          console.log(JSON.stringify({ base, results }, null, 2));
          return;
        }
        const unique = new Set<string>();
        for (const r of results) for (const t of r.tests) unique.add(t.file);
        console.log(kleur.bold(`${unique.size} test file(s) cover ${results.length} changed symbol(s):`));
        for (const f of [...unique].sort()) console.log(`  ${kleur.cyan(f)}`);
        return;
      }
      if (!symbol) throw new Error("symbol is required (or pass --diff)");
      const ctx = await openQuery(root);
      const sym = resolveSymbol(symbol, ctx);
      if (!sym) throw new Error(`symbol not found: ${symbol}`);
      const tests = await testsForSymbol(sym.name, sym.file, root, ctx.index);
      if (opts.json) console.log(JSON.stringify({ symbol: sym, tests }, null, 2));
      else console.log(formatTestsPretty(sym.name, tests));
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}
