import type { Command } from "commander";
import kleur from "kleur";
import { importRuntimeJSON, loadRuntime, runtimeForSymbol } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

export function registerRuntime(program: Command): void {
  const cmd = program.command("runtime").description("Manage the runtime evidence strand");

  addRootOption(
    cmd
      .command("import <file>")
      .description("Import runtime events from a JSON file (Sentry/Datadog/OTel exports)"),
  ).action(async (file: string, opts: RootOption) => {
    const root = resolveRoot(opts);
    try {
      const store = await importRuntimeJSON(root, file);
      console.log(kleur.green(`✓ imported ${store.events.length} event(s) → .gps/runtime.json`));
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });

  addRootOption(
    cmd
      .command("show <symbol>")
      .description("Show runtime events for a symbol")
      .option("--json", "Emit JSON"),
  ).action(async (symbol: string, opts: RootOption & { json?: boolean }) => {
    const root = resolveRoot(opts);
    const store = await loadRuntime(root);
    const events = runtimeForSymbol(symbol, store);
    if (opts.json) {
      console.log(JSON.stringify({ symbol, events }, null, 2));
      return;
    }
    if (events.length === 0) {
      console.log(kleur.dim(`no runtime events for ${symbol}`));
      return;
    }
    console.log(kleur.bold(`${events.length} runtime event(s) for ${symbol}:`));
    for (const e of events) {
      const sev = e.severity ?? "—";
      const color = e.severity === "critical" || e.severity === "high" ? kleur.red : kleur.yellow;
      console.log(`  ${color(sev)}  [${e.kind}/${e.source}]  ${e.message}`);
      console.log(kleur.dim(`        ${e.at}${e.count ? ` ×${e.count}` : ""}${e.url ? ` ${e.url}` : ""}`));
    }
  });
}
