import type { Command } from "commander";
import kleur from "kleur";
import { pruneNotes } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface PruneOpts extends RootOption {
  days?: string;
  dryRun?: boolean;
  json?: boolean;
}

export function registerPrune(program: Command): void {
  addRootOption(
    program
      .command("prune")
      .description(
        "Remove stale notes that have not been surfaced for --days days (default 90). " +
        "Notes that are promoted, high-severity, or from trusted sources (human/doc/incident/pr) " +
        "are never removed. Use --dry-run to preview without writing.",
      )
      .option("--days <n>", "Staleness threshold in days (default: 90)", "90")
      .option("--dry-run", "Preview removals without writing changes")
      .option("--json", "Emit JSON output"),
  ).action(async (opts: PruneOpts) => {
    const root = resolveRoot(opts);
    const days = Number(opts.days ?? 90);
    if (!Number.isFinite(days) || days < 1) {
      console.error(kleur.red("--days must be a positive number"));
      process.exitCode = 1;
      return;
    }
    const dryRun = opts.dryRun ?? false;

    let report;
    try {
      report = await pruneNotes(root, { days, dryRun });
    } catch (err) {
      console.error(kleur.red(`prune failed: ${(err as Error).message}`));
      process.exitCode = 1;
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    if (report.removed === 0) {
      console.log(kleur.dim(`No stale notes found (threshold: ${days}d).`));
      return;
    }

    const action = dryRun ? "Would remove" : "Removed";
    console.log(
      kleur.bold(`${action} ${report.removed} note${report.removed === 1 ? "" : "s"}`) +
        (dryRun ? kleur.yellow(" [dry-run]") : ""),
    );
    for (const d of report.details) {
      console.log(
        `  ${kleur.dim("·")} ${kleur.bold(d.symbol)}: ${d.lesson.slice(0, 80)}${d.lesson.length > 80 ? "…" : ""}`,
      );
      console.log(`    ${kleur.dim(d.reason)}`);
    }
  });
}
