import type { Command } from "commander";
import kleur from "kleur";
import { readIndex, searchSymbols } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

export function registerFind(program: Command): void {
  addRootOption(program
    .command("find <query>")
    .description("Fuzzy search for symbols (matches names and, on v2 indexes, body/doc tokens)")
    .option("--json", "Emit JSON instead of pretty output")
    .option("--limit <n>", "Max results", (v) => parseInt(v, 10), 20))
    .action(async (query: string, opts: RootOption & { json?: boolean; limit: number }) => {
      const root = resolveRoot(opts);
      try {
        const index = await readIndex(root);
        const matches = searchSymbols(index, query, opts.limit);
        if (opts.json) {
          // Additive contract: every prior SymbolRef field is preserved and we
          // add match_reason + score. `tokens` is an index-internal recall aid,
          // not useful in result output, so it's dropped here.
          console.log(
            JSON.stringify(
              matches.map(({ symbol, match_reason, score }) => {
                const { tokens: _tokens, ...rest } = symbol;
                return { ...rest, match_reason, score };
              }),
              null,
              2,
            ),
          );
          return;
        }
        if (matches.length === 0) {
          console.log(kleur.dim(`no symbols match "${query}"`));
          return;
        }
        for (const { symbol: s, match_reason } of matches) {
          const why = match_reason === "tokens" ? kleur.dim("  ← matched in body/docs") : "";
          console.log(`${s.name}  ${kleur.dim(`(${s.kind})  ${s.file}:${s.line}`)}${why}`);
        }
      } catch (e) {
        console.error(kleur.red(`error: ${(e as Error).message}`));
        process.exitCode = 1;
      }
    });
}
