import type { Command } from "commander";
import kleur from "kleur";
import {
  open as openQuery,
  resolveSymbol,
  logForFile,
  isGitRepo,
  formatTracePretty,
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

export function registerTrace(program: Command): void {
  addRootOption(program
    .command("trace <symbol>")
    .description("Git provenance for a symbol (who, when, last changes)")
    .option("--json", "Emit JSON instead of pretty output")
    .option("--limit <n>", "Number of commits", (v) => parseInt(v, 10), 10))
    .action(async (symbol: string, opts: RootOption & { json?: boolean; limit: number }) => {
      const root = resolveRoot(opts);
      try {
        const ctx = await openQuery(root);
        const sym = resolveSymbol(symbol, ctx);
        if (!sym) throw new Error(`symbol not found: ${symbol}`);
        if (!(await isGitRepo(root))) {
          console.log(kleur.dim("not a git repo — no provenance available."));
          return;
        }
        const entries = await logForFile(root, sym.file, opts.limit);
        if (opts.json) console.log(JSON.stringify(entries, null, 2));
        else console.log(formatTracePretty(sym.name, entries));
      } catch (e) {
        console.error(kleur.red(`error: ${(e as Error).message}`));
        process.exitCode = 1;
      }
    });
}
