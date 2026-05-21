import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import path from "node:path";
import kleur from "kleur";
import {
  loadConfig,
  scanFiles,
  extractTodos,
  appendNote,
  loadNotes,
  pruneStaleTodoNotes,
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

export function registerLearnTodos(program: Command): void {
  addRootOption(
    program
      .command("learn-todos")
      .description("Lift TODO(symbol): / FIXME(symbol): comments in the repo into notes")
      .option("--dry-run", "Print what would be recorded; write nothing")
      .option(
        "--prune",
        "Also drop todo-sourced notes whose backing comment is gone (keeps the loop in sync)",
      )
      .option("--quiet", "Suppress per-item output (for hook use)"),
  ).action(async (opts: RootOption & { dryRun?: boolean; prune?: boolean; quiet?: boolean }) => {
    const root = resolveRoot(opts);
    const config = await loadConfig(root);
    const files = await scanFiles(root, config);
    const log = (msg: string) => {
      if (!opts.quiet) console.log(msg);
    };
    // symbol -> set of live TODO lesson texts, used both to lift new notes and
    // to prune notes whose comment has since been deleted.
    const live = new Map<string, Set<string>>();
    let lifted = 0;
    let skipped = 0;
    let pruned = 0;
    for (const abs of files) {
      let src: string;
      try {
        src = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      const rel = path.relative(root, abs);
      const todos = extractTodos(src, rel);
      for (const t of todos) {
        if (!live.has(t.symbol)) live.set(t.symbol, new Set());
        live.get(t.symbol)!.add(t.lesson);
        const existing = await loadNotes(root, t.symbol);
        const dup = existing.find((n) => n.lesson === t.lesson && n.source === "todo");
        if (dup) {
          skipped++;
          continue;
        }
        if (opts.dryRun) {
          log(`${kleur.dim("would record")} ${kleur.bold(t.symbol)} → ${t.lesson}`);
        } else {
          await appendNote(root, {
            symbol: t.symbol,
            lesson: t.lesson,
            evidence: t.evidence,
            severity: "medium",
            source: "todo",
          });
          log(`${kleur.green("lifted")} ${kleur.bold(t.symbol)} → ${t.lesson}`);
        }
        lifted++;
      }
    }

    if (opts.prune) {
      // Any todo-sourced note whose (symbol, lesson) is no longer present in the
      // codebase is stale — the comment was resolved/removed. Drop it so prepare
      // stops surfacing dead TODOs.
      pruned = await pruneStaleTodoNotes(root, live, { dryRun: opts.dryRun });
      if (pruned) log(`${kleur.yellow(`pruned ${pruned}`)} stale todo note(s)`);
    }

    log("");
    log(
      `${kleur.bold(`${lifted}`)} ${lifted === 1 ? "note" : "notes"} ${opts.dryRun ? "would be lifted" : "lifted"}` +
        (skipped ? kleur.dim(`  (${skipped} already recorded)`) : "") +
        (pruned ? kleur.dim(`  (${pruned} ${opts.dryRun ? "would be pruned" : "pruned"})`) : ""),
    );
    if (!lifted && !pruned)
      log(
        kleur.dim(
          'hint: use `// TODO(symbolName): lesson text` (or FIXME/XXX) anywhere in your code',
        ),
      );
  });
}
