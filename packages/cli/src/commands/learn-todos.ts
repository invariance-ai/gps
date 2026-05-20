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
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

export function registerLearnTodos(program: Command): void {
  addRootOption(
    program
      .command("learn-todos")
      .description("Lift TODO(symbol): / FIXME(symbol): comments in the repo into notes")
      .option("--dry-run", "Print what would be recorded; write nothing"),
  ).action(async (opts: RootOption & { dryRun?: boolean }) => {
    const root = resolveRoot(opts);
    const config = await loadConfig(root);
    const files = await scanFiles(root, config);
    let lifted = 0;
    let skipped = 0;
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
        const existing = await loadNotes(root, t.symbol);
        const dup = existing.find((n) => n.lesson === t.lesson && n.source === "todo");
        if (dup) {
          skipped++;
          continue;
        }
        if (opts.dryRun) {
          console.log(`${kleur.dim("would record")} ${kleur.bold(t.symbol)} → ${t.lesson}`);
        } else {
          await appendNote(root, {
            symbol: t.symbol,
            lesson: t.lesson,
            evidence: t.evidence,
            severity: "medium",
            source: "todo",
          });
          console.log(`${kleur.green("lifted")} ${kleur.bold(t.symbol)} → ${t.lesson}`);
        }
        lifted++;
      }
    }
    console.log("");
    console.log(
      `${kleur.bold(`${lifted}`)} ${lifted === 1 ? "note" : "notes"} ${opts.dryRun ? "would be lifted" : "lifted"}` +
        (skipped ? kleur.dim(`  (${skipped} already recorded)`) : ""),
    );
    if (!lifted)
      console.log(
        kleur.dim(
          'hint: use `// TODO(symbolName): lesson text` (or FIXME/XXX) anywhere in your code',
        ),
      );
  });
}
