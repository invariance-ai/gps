import type { Command } from "commander";
import kleur from "kleur";
import { inferSymbols } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface PlanOpts extends RootOption {
  json?: boolean;
  limit: number;
}

export function registerPlan(program: Command): void {
  addRootOption(
    program
      .command("plan <prompt...>")
      .description("Rank candidate symbols for a prompt (used before `prepare`)")
      .option("--limit <n>", "Max candidates", (v) => parseInt(v, 10), 5)
      .option("--json", "Emit JSON"),
  ).action(async (parts: string[], opts: PlanOpts) => {
    const root = resolveRoot(opts);
    const prompt = parts.join(" ").trim();
    if (!prompt) {
      console.error(kleur.red("error: prompt is required"));
      process.exitCode = 1;
      return;
    }
    const matches = await inferSymbols(root, prompt, { limit: opts.limit });
    if (opts.json) {
      console.log(JSON.stringify({ prompt, matches }, null, 2));
      return;
    }
    if (matches.length === 0) {
      console.log(kleur.dim("no symbol matches; try `gps index` first or be more specific"));
      return;
    }
    console.log(kleur.bold(`top ${matches.length} symbol(s) for prompt:`));
    for (const m of matches) {
      const conf = m.score.toString().padStart(3, " ");
      const color = m.score >= 95 ? kleur.green : m.score >= 80 ? kleur.cyan : kleur.yellow;
      console.log(
        `  ${color(conf)}  ${kleur.cyan(m.symbol.qualified_name ?? m.symbol.name)} ${kleur.dim(`${m.symbol.file}:${m.symbol.line} (${m.via})`)}`,
      );
    }
    const top = matches[0]!;
    console.log(
      kleur.dim(
        `\nnext: gps prepare ${top.symbol.qualified_name ?? top.symbol.name} --intent "<what you plan to change>"`,
      ),
    );
  });
}
