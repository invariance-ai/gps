import type { Command } from "commander";
import kleur from "kleur";
import {
  suggest,
  listPending,
  DEFAULT_COUNT_GATE,
  DEFAULT_CONFIDENCE_GATE,
  type PendingLesson,
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

/**
 * Pending global lessons that have recurred but haven't cleared the promotion
 * gates yet — one or two more observations from becoming a standing rule.
 * This is the lesson side of the authoring queue.
 */
function nearPromotion(pending: PendingLesson[]): PendingLesson[] {
  return pending
    .filter(
      (p) =>
        !(p.count >= DEFAULT_COUNT_GATE && p.confidence >= DEFAULT_CONFIDENCE_GATE) &&
        p.count >= 1,
    )
    .sort((a, b) => b.count - a.count || b.confidence - a.confidence);
}

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
        const lessons = nearPromotion(await listPending(root)).slice(0, opts.limit);
        if (opts.json) {
          console.log(
            JSON.stringify({ suggestions: results, lessons_near_promotion: lessons }, null, 2),
          );
          return;
        }
        if (results.length === 0 && lessons.length === 0) {
          console.log(
            kleur.dim(
              "no suggestions — either no observations recorded yet (start `gps serve --observe`) or all hot symbols already have invariants.",
            ),
          );
          return;
        }
        if (results.length > 0) {
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
        }
        if (lessons.length > 0) {
          if (results.length > 0) console.log("");
          console.log(
            kleur.bold(`${lessons.length} lesson(s) near promotion to a standing rule:`),
          );
          for (const l of lessons) {
            const needs = Math.max(0, DEFAULT_COUNT_GATE - l.count);
            const gap = needs > 0 ? `${needs} more observation(s)` : "raise confidence";
            console.log(
              `  ${l.text}  ${kleur.dim(`(seen ${l.count}×, conf ${l.confidence.toFixed(2)} — needs ${gap})`)}`,
            );
          }
        }
      } catch (e) {
        console.error(kleur.red(`error: ${(e as Error).message}`));
        process.exitCode = 1;
      }
    },
  );
}
