import type { Command } from "commander";
import kleur from "kleur";
import { pruneNotes, type PruneDetail } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface PruneOpts extends RootOption {
  days?: string;
  minConfidence?: string;
  auto?: boolean;
  intervalDays?: string;
  dryRun?: boolean;
  quiet?: boolean;
  json?: boolean;
}

export function registerPrune(program: Command): void {
  addRootOption(
    program
      .command("prune")
      .description(
        "Remove stale notes that have not been surfaced for --days days (default 90). " +
        "Promoted, verified, high-severity, trusted-source, and high-confidence memories " +
        "are never removed. Use --dry-run to preview without writing.",
      )
      .option("--days <n>", "Staleness threshold in days (default: 90)", "90")
      .option("--min-confidence <n>", "Keep memories at or above this confidence (default: 0.8)", "0.8")
      .option("--auto", "Background mode: no-op unless the interval has elapsed")
      .option("--interval-days <n>", "Background run cadence in days (default: 7)", "7")
      .option("--dry-run", "Preview removals without writing changes")
      .option("--quiet", "Suppress stdout when nothing is removed")
      .option("--json", "Emit JSON output"),
  ).action(async (opts: PruneOpts) => {
    const root = resolveRoot(opts);
    const days = Number(opts.days ?? 90);
    if (!Number.isFinite(days) || days < 1) {
      console.error(kleur.red("--days must be a positive number"));
      process.exitCode = 1;
      return;
    }
    const minConfidence = Number(opts.minConfidence ?? 0.8);
    if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      console.error(kleur.red("--min-confidence must be a number between 0 and 1"));
      process.exitCode = 1;
      return;
    }
    const intervalDays = Number(opts.intervalDays ?? 7);
    if (!Number.isFinite(intervalDays) || intervalDays < 1) {
      console.error(kleur.red("--interval-days must be a positive number"));
      process.exitCode = 1;
      return;
    }
    const dryRun = opts.dryRun ?? false;

    let report;
    try {
      report = await pruneNotes(root, {
        days,
        dryRun,
        minConfidence,
        auto: opts.auto,
        intervalDays,
      } as Parameters<typeof pruneNotes>[1]);
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
      if (opts.quiet) return;
      console.log(kleur.dim(`No stale notes found (threshold: ${days}d).`));
      return;
    }

    const action = dryRun ? "Would remove" : "Removed";
    console.log(
      kleur.bold(`${action} ${report.removed} memor${report.removed === 1 ? "y" : "ies"}`) +
        (dryRun ? kleur.yellow(" [dry-run]") : ""),
    );
    for (const d of report.details as Array<PruneDetail & { kind?: string; text?: string; lesson?: string; file?: string }>) {
      const text = d.text ?? d.lesson ?? "";
      console.log(
        `  ${kleur.dim("·")} ${kleur.bold(d.symbol)} ${kleur.dim(`[${d.kind ?? "note"}]`)}: ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`,
      );
      console.log(`    ${kleur.dim(d.file ? `${d.reason} — ${d.file}` : d.reason)}`);
    }
  });
}
