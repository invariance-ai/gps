import type { Command } from "commander";
import kleur from "kleur";
import {
  impactOf,
  formatImpactPretty,
  formatImpactMarkdown,
  diffSymbols,
  open as openQuery,
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface ImpactOpts extends RootOption {
  json?: boolean;
  markdown?: boolean;
  hops: number;
  diff?: boolean;
  base: string;
}

export function registerImpact(program: Command): void {
  addRootOption(
    program
      .command("impact [symbol]")
      .description("Blast radius (symbols, files, tests) of changing a symbol, or every symbol in the diff")
      .option("--json", "Emit JSON (best for tool chaining)")
      .option("--markdown", "Emit markdown (best for piping into an LLM)")
      .option("--hops <n>", "Transitive caller depth", (v) => parseInt(v, 10), 3)
      .option("--diff", "Compute impact for every symbol in the working-tree diff")
      .option("--base <ref>", "Diff base (default HEAD)", "HEAD"),
  ).action(async (symbol: string | undefined, opts: ImpactOpts) => {
    try {
      const root = resolveRoot(opts);
      if (opts.diff) {
        const { base, files, symbols } = await diffSymbols(root, opts.base);
        if (symbols.length === 0) {
          if (opts.json) console.log(JSON.stringify({ base, files, results: [] }, null, 2));
          else console.log(kleur.dim(`no indexed symbols in diff vs ${base}`));
          return;
        }
        const ctx = await openQuery(root);
        const results = [];
        for (const s of symbols) {
          const id = s.qualified_name ?? s.name;
          try {
            results.push(await impactOf({ symbol: id, hops: opts.hops }, ctx));
          } catch {
            /* skip unresolved */
          }
        }
        if (opts.json) {
          console.log(JSON.stringify({ base, files, results }, null, 2));
          return;
        }
        console.log(kleur.bold(`impact for ${results.length} symbol(s) changed vs ${base}:`));
        for (const r of results) {
          console.log("\n" + (opts.markdown ? formatImpactMarkdown(r) : formatImpactPretty(r)));
        }
        return;
      }

      if (!symbol) throw new Error("symbol is required (or pass --diff)");
      const r = await impactOf({ symbol, hops: opts.hops }, root);
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      else if (opts.markdown) console.log(formatImpactMarkdown(r));
      else console.log(formatImpactPretty(r));
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}
