import type { Command } from "commander";
import kleur from "kleur";
import { readIndex, staleFiles } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface ValidateOpts extends RootOption {
  json?: boolean;
  quiet?: boolean;
  /** Limit how many stale paths we list before truncating. */
  limit: number;
}

/**
 * Pre-attribution correctness gate. Compares each indexed file's mtime to the
 * index's built_at; exits non-zero if anything is stale or missing so the Stop
 * hook can refuse to attribute against a stale graph.
 */
export function registerValidate(program: Command): void {
  addRootOption(
    program
      .command("validate")
      .description("Check the symbol graph is in sync with the working tree")
      .option("--json", "Emit JSON")
      .option("--quiet", "Print only on failure")
      .option("--limit <n>", "Max stale paths to list", (v) => parseInt(v, 10), 20),
  ).action(async (opts: ValidateOpts) => {
    const root = resolveRoot(opts);
    let index;
    try {
      index = await readIndex(root);
    } catch {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, reason: "no_index" }));
      } else if (!opts.quiet) {
        console.error(kleur.yellow("no index found — run `gps index` first"));
      } else {
        console.error("no index — run `gps index`");
      }
      process.exit(2);
      return;
    }
    const report = await staleFiles(root, index);
    const ok = report.stale_files.length === 0 && report.missing_files.length === 0;
    if (opts.json) {
      console.log(JSON.stringify({ ok, ...report }, null, 2));
      if (!ok) process.exit(1);
      return;
    }
    if (ok) {
      if (!opts.quiet) {
        console.log(
          kleur.green("ok") +
            kleur.dim(` (${report.total_files} files indexed at ${report.built_at})`),
        );
      }
      return;
    }
    const total = report.stale_files.length + report.missing_files.length;
    console.error(
      kleur.yellow(`stale index: ${total} file(s) changed since ${report.built_at}`),
    );
    for (const f of report.stale_files.slice(0, opts.limit)) {
      console.error(`  ${kleur.yellow("M")} ${f}`);
    }
    for (const f of report.missing_files.slice(0, opts.limit)) {
      console.error(`  ${kleur.red("D")} ${f}`);
    }
    if (total > opts.limit) {
      console.error(kleur.dim(`  … and ${total - opts.limit} more`));
    }
    console.error(kleur.dim("run `gps index` to rebuild before attribution"));
    process.exit(1);
  });
}
