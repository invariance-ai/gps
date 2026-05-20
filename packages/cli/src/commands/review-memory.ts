import type { Command } from "commander";
import kleur from "kleur";
import { buildReviewQueue } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  days: number;
  limit: number;
  json?: boolean;
}

export function registerReviewMemory(program: Command): void {
  addRootOption(
    program
      .command("review-memory")
      .description("Maintainer queue: promotions, stale entries, open questions")
      .option("--days <n>", "Staleness threshold in days", (v) => parseInt(v, 10), 90)
      .option("--limit <n>", "Cap per section", (v) => parseInt(v, 10), 25)
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    const q = await buildReviewQueue(root, { days: opts.days, limit: opts.limit });
    if (opts.json) {
      console.log(JSON.stringify(q, null, 2));
      return;
    }
    if (q.total === 0) {
      console.log(kleur.green("✓ memory is clean — nothing to review"));
      return;
    }
    console.log(kleur.bold(`memory review queue (${q.total} items)`));

    if (q.promote.length > 0) {
      console.log(kleur.cyan(`\nPromote (${q.promote.length}) — repeated notes ready to become invariants:`));
      for (const p of q.promote.slice(0, opts.limit)) {
        console.log(`  ${kleur.yellow(p.symbol)}  ${kleur.dim(`[${p.severity_hint}]`)}  ${p.representative_lesson}`);
        console.log(kleur.dim(`    ${p.notes.length} similar notes`));
      }
    }
    if (q.stale.length > 0) {
      console.log(kleur.cyan(`\nStale (${q.stale.length}) — entries older than ${opts.days}d whose file moved:`));
      for (const s of q.stale.slice(0, opts.limit)) {
        const flag = s.file_changed_since ? kleur.yellow("⚠") : " ";
        console.log(`  ${flag} ${kleur.dim(`${s.age_days}d`)}  ${kleur.cyan(s.kind)}  ${s.symbol}  ${kleur.dim(s.text.slice(0, 80))}`);
      }
    }
    if (q.open_questions.length > 0) {
      console.log(kleur.cyan(`\nOpen questions (${q.open_questions.length}):`));
      for (const oq of q.open_questions.slice(0, opts.limit)) {
        console.log(`  ${kleur.dim(`${oq.age_days}d`)}  ${kleur.cyan(oq.symbol)}  ${oq.question}`);
      }
    }
  });
}
