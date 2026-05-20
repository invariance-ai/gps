import type { Command } from "commander";
import kleur from "kleur";
import {
  gate,
  gateChanged,
  watchGateStream,
  type GateHit,
  type GateResult,
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface GateOpts extends RootOption {
  diff?: boolean;
  base?: string;
  json?: boolean;
  watch?: boolean;
  changed?: boolean;
  debounce?: string;
}

export function registerGate(program: Command): void {
  addRootOption(
    program
      .command("gate")
      .description("Fail when changed files touch blocking invariants (unless waived)")
      .option("--diff", "Gate the current working diff", false)
      .option("--base <ref>", "Diff base (default HEAD)", "HEAD")
      .option("--changed", "Only evaluate symbols whose lines actually changed (hunk-level)")
      .option("--watch", "Stream gate findings as files change (long-running)")
      .option("--debounce <ms>", "Debounce window for --watch (default 500ms)")
      .option("--json", "Emit JSON"),
  ).action(async (opts: GateOpts) => {
    const root = resolveRoot(opts);

    if (opts.watch) {
      const debounceMs = opts.debounce ? Number(opts.debounce) : undefined;
      console.log(kleur.dim(`watching ${root} for gate violations (Ctrl-C to stop)`));
      const handle = await watchGateStream(root, {
        debounceMs,
        base: opts.base,
        onEntry: (entry) => {
          if (opts.json) {
            console.log(JSON.stringify(entry));
          } else {
            console.log(kleur.bold(`\n[${entry.ts}]`) + kleur.dim(` ${entry.changed_files.length} file(s) touched`));
            for (const h of entry.hits) printHit(h);
            if (entry.blocking.length > 0) {
              console.log(kleur.red(`  ✗ ${entry.blocking.length} blocking`));
            }
          }
        },
      });
      const shutdown = (): void => {
        // Await stop() so in-flight evaluate() and the JSONL writer flush
        // cleanly before we exit.
        handle.stop().finally(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }

    const result: GateResult = opts.changed
      ? await gateChanged(root, { base: opts.base })
      : await gate(root, { base: opts.base });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.blocking.length > 0 ? 1 : 0;
      return;
    }

    if (result.changed_files.length === 0) {
      console.log(kleur.dim("no changed files; nothing to gate"));
      return;
    }
    console.log(
      kleur.dim(`gating ${result.changed_files.length} file(s), ${result.changed_symbols.length} symbol(s) vs ${result.base}`),
    );
    if (result.hits.length === 0) {
      console.log(kleur.green("✓ no invariants apply to the diff"));
      return;
    }
    for (const h of result.hits) printHit(h);
    if (result.blocking.length > 0) {
      console.log(
        kleur.red(`\n✗ ${result.blocking.length} blocking invariant(s); waive with: gps waive <name> --reason <...>`),
      );
      process.exitCode = 1;
    } else {
      console.log(kleur.green(`\n✓ no blocking violations`));
    }
  });
}

function printHit(h: GateHit): void {
  const sev = h.invariant.severity;
  const tag =
    sev === "block" ? (h.waived ? kleur.yellow("WAIVED") : kleur.red("BLOCK")) :
    sev === "warn" ? kleur.yellow("WARN") : kleur.dim("INFO");
  console.log(`  ${tag}  ${kleur.cyan(h.invariant.name)} — ${h.invariant.rule}`);
  if (h.symbols.length) console.log(kleur.dim(`        symbols: ${h.symbols.slice(0, 5).join(", ")}${h.symbols.length > 5 ? "…" : ""}`));
  else if (h.files.length) console.log(kleur.dim(`        files: ${h.files.slice(0, 5).join(", ")}${h.files.length > 5 ? "…" : ""}`));
  if (h.waiver) console.log(kleur.dim(`        waiver: ${h.waiver.reason} (${h.waiver.at})`));
}
