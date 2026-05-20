import type { Command } from "commander";
import kleur from "kleur";
import { suggest } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

export function registerSuggest(program: Command): void {
  addRootOption(
    program
      .command("suggest")
      .description("Symbols with high query traffic and no covering invariant — the authoring queue")
      .option("--min <n>", "Minimum query count to include", (v) => parseInt(v, 10), 3)
      .option("--limit <n>", "Max suggestions", (v) => parseInt(v, 10), 10)
      .option("--json", "Emit JSON"),
  ).action(
    async (
      opts: RootOption & { min: number; limit: number; json?: boolean },
    ) => {
      const root = resolveRoot(opts);
      try {
        const results = await suggest(root, { min_count: opts.min, limit: opts.limit });
        if (opts.json) {
          console.log(JSON.stringify({ suggestions: results }, null, 2));
          return;
        }
        if (results.length === 0) {
          console.log(
            kleur.dim(
              "no suggestions — either no observations recorded yet (start `gps serve --observe`) or all hot symbols already have invariants.",
            ),
          );
          return;
        }
        console.log(kleur.bold(`${results.length} symbol(s) worth documenting:`));
        for (const s of results) {
          const ago = s.last_queried.slice(0, 10);
          const stats =
            s.failure_count > 0
              ? `${s.failure_count} failures, ${s.count} queries, last ${ago}`
              : `${s.count} queries, last ${ago}`;
          const tag = s.reason === "failure" ? kleur.red(s.reason) : kleur.cyan(s.reason);
          console.log(`  ${kleur.bold(s.symbol)}  ${kleur.dim(stats)}  ${tag}`);
        }
      } catch (e) {
        console.error(kleur.red(`error: ${(e as Error).message}`));
        process.exitCode = 1;
      }
    },
  );
}
