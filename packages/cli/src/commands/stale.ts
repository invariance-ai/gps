import type { Command } from "commander";
import kleur from "kleur";
import { findStale } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface StaleOpts extends RootOption {
  days?: string;
  feature?: string;
  json?: boolean;
  changedOnly?: boolean;
}

export function registerStale(program: Command): void {
  addRootOption(
    program
      .command("stale")
      .description("List notes/decisions/open questions older than --days whose file has since changed")
      .option("--days <n>", "Age threshold in days", "90")
      .option("--feature <label>", "Restrict to a feature's symbol bag")
      .option("--changed-only", "Only show entries whose underlying file has changed since")
      .option("--json", "Emit JSON"),
  ).action(async (opts: StaleOpts) => {
    const root = resolveRoot(opts);
    const days = Number(opts.days ?? 90);
    if (!Number.isFinite(days) || days < 0) {
      console.error(kleur.red("--days must be a non-negative number"));
      process.exitCode = 1;
      return;
    }
    let entries = await findStale(root, { days, feature: opts.feature });
    if (opts.changedOnly) entries = entries.filter((e) => e.file_changed_since);

    if (opts.json) {
      console.log(JSON.stringify({ days, feature: opts.feature, entries }, null, 2));
      return;
    }
    if (entries.length === 0) {
      console.log(kleur.dim(`no stale entries older than ${days}d`));
      return;
    }
    for (const e of entries) {
      const flag = e.file_changed_since ? kleur.red("!") : kleur.dim(" ");
      const kind = kleur.dim(`[${e.kind}]`);
      console.log(`${flag} ${kind} ${kleur.bold(e.symbol)} ${kleur.dim(`(${e.age_days}d)`)}`);
      console.log(`    ${e.text}`);
      if (e.file) console.log(`    ${kleur.dim(e.file)}`);
    }
  });
}
