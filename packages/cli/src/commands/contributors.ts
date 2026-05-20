import type { Command } from "commander";
import kleur from "kleur";
import { rankContributors } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  json?: boolean;
  limit?: string;
}

export function registerContributors(program: Command): void {
  addRootOption(
    program
      .command("contributors <symbol>")
      .description("Who has the most context on this symbol (commits + decisions)")
      .option("--limit <n>", "Max contributors to show", "10")
      .option("--json", "Emit JSON"),
  ).action(async (symbol: string, opts: Opts) => {
    const root = resolveRoot(opts);
    const limit = Number(opts.limit ?? 10);
    const all = await rankContributors(root, symbol);
    const out = all.slice(0, limit);
    if (opts.json) {
      console.log(JSON.stringify({ symbol, contributors: out }, null, 2));
      return;
    }
    if (out.length === 0) {
      console.log(kleur.dim(`no contributors recorded for ${symbol}`));
      return;
    }
    console.log(kleur.bold(symbol));
    for (const c of out) {
      console.log(
        `  ${c.name.padEnd(30)} ${kleur.dim(`score=${c.score.toFixed(2)} commits=${c.commits} decisions=${c.decisions}`)}`,
      );
    }
  });
}
