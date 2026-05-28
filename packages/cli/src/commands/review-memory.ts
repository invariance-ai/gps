import type { Command } from "commander";
import kleur from "kleur";
import { buildReviewQueue, removeNoteById, updateNoteById, reclassifyLesson } from "@invariance/gps-core";
import type { NoteScope } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  days: number;
  limit: number;
  json?: boolean;
}

interface IdOpts extends RootOption {
  by?: string;
}

interface PromoteOpts extends RootOption {
  to: string;
  target?: string;
}

function validScope(scope: string): NoteScope | undefined {
  if (scope === "global" || scope === "symbol" || scope === "file" || scope === "feature" || scope === "area") return scope;
  return undefined;
}

export function registerReviewMemory(program: Command): void {
  const cmd = program
      .command("review-memory")
      .description("Maintainer queue: approve, reject, or promote captured memories");

  addRootOption(
    cmd
      .command("list", { isDefault: true })
      .description("List promotions, stale entries, and open questions")
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

  addRootOption(
    cmd
      .command("approve <id>")
      .description("Mark a captured note as human-verified trusted context")
      .option("--by <who>", "Reviewer identity"),
  ).action(async (id: string, opts: IdOpts) => {
    const root = resolveRoot(opts);
    const updated = await updateNoteById(root, id, {
      verified_by: opts.by ?? "human",
      verified_at: new Date().toISOString(),
      confidence: 1.0,
    });
    if (!updated) {
      console.log(kleur.red(`✗ note ${id} not found`));
      process.exitCode = 1;
      return;
    }
    console.log(kleur.green(`✓ approved ${id}`));
    console.log(kleur.dim(`  ${updated.path}`));
  });

  addRootOption(
    cmd
      .command("reject <id>")
      .description("Remove a captured note from memory")
  ).action(async (id: string, opts: RootOption) => {
    const root = resolveRoot(opts);
    const removed = await removeNoteById(root, id);
    if (!removed) {
      console.log(kleur.red(`✗ note ${id} not found`));
      process.exitCode = 1;
      return;
    }
    console.log(kleur.green(`✓ rejected ${id}`));
    console.log(kleur.dim(`  removed from ${removed.path}`));
  });

  addRootOption(
    cmd
      .command("promote <id>")
      .description("Move a note to a more durable scope")
      .requiredOption("--to <scope>", "global | symbol | file | feature | area")
      .option("--target <target>", "Required for symbol|file|feature|area"),
  ).action(async (id: string, opts: PromoteOpts) => {
    const root = resolveRoot(opts);
    try {
      const to = validScope(opts.to);
      if (!to) throw new Error("--to must be one of: global, symbol, file, feature, area");
      const result = await reclassifyLesson(root, {
        id,
        to_scope: to,
        to_target: opts.target,
      });
      console.log(kleur.green(`✓ promoted ${id} to ${result.to_scope}`));
      console.log(kleur.dim(`  ${result.path}`));
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}
