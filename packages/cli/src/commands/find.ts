import type { Command } from "commander";
import kleur from "kleur";
import { readIndex } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

export function registerFind(program: Command): void {
  addRootOption(program
    .command("find <query>")
    .description("Fuzzy search for symbols")
    .option("--json", "Emit JSON instead of pretty output")
    .option("--limit <n>", "Max results", (v) => parseInt(v, 10), 20))
    .action(async (query: string, opts: RootOption & { json?: boolean; limit: number }) => {
      const root = resolveRoot(opts);
      try {
        const index = await readIndex(root);
        const q = query.toLowerCase();
        const scored = index.symbols
          .map((s) => {
            const name = s.name.toLowerCase();
            const qualified = s.qualified_name?.toLowerCase();
            let score = 0;
            if (qualified === q) score = 100;
            else if (name === q) score = 95;
            else if (qualified?.startsWith(q)) score = 85;
            else if (name.startsWith(q)) score = 80;
            else if (qualified?.includes(q)) score = 65;
            else if (name.includes(q)) score = 60;
            else return null;
            return { s, score };
          })
          .filter((x): x is { s: typeof index.symbols[0]; score: number } => !!x)
          .sort((a, b) => b.score - a.score)
          .slice(0, opts.limit);
        if (opts.json) {
          console.log(JSON.stringify(scored.map((x) => x.s), null, 2));
          return;
        }
        if (scored.length === 0) {
          console.log(kleur.dim(`no symbols match "${query}"`));
          return;
        }
        for (const { s } of scored) {
          console.log(`${s.name}  ${kleur.dim(`(${s.kind})  ${s.file}:${s.line}`)}`);
        }
      } catch (e) {
        console.error(kleur.red(`error: ${(e as Error).message}`));
        process.exitCode = 1;
      }
    });
}
