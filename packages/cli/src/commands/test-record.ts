import type { Command } from "commander";
import kleur from "kleur";
import {
  recordTestRun,
  parseFailedTests,
  readObservations,
  diffSymbols,
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  command: string;
  exit: number;
  symbol?: string;
  feature?: string;
  message?: string;
  json?: boolean;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function registerTestRecord(program: Command): void {
  addRootOption(
    program
      .command("test-record")
      .description("Record a test run tied to active symbols (surfaces in `gps prepare` later)")
      .requiredOption("--command <cmd>", "The test command that was run")
      .requiredOption("--exit <code>", "Exit code", (v) => parseInt(v, 10))
      .option("--symbol <name>", "Symbol to attribute (defaults to last-prepared)")
      .option("--feature <label>", "Feature label to attribute")
      .option("--message <m>", "Short note")
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    const output = (await readStdin()).slice(0, 200_000);
    const failed = parseFailedTests(output);

    const symbols = new Set<string>();
    if (opts.symbol) symbols.add(opts.symbol);
    if (!opts.symbol) {
      const store = await readObservations(root).catch(() => null);
      if (store?.last_prepared_symbol) symbols.add(store.last_prepared_symbol);
    }
    if (symbols.size === 0) {
      // Last fallback: derive from working-tree diff.
      try {
        const { symbols: diff } = await diffSymbols(root);
        for (const s of diff.slice(0, 5)) symbols.add(s.qualified_name ?? s.name);
      } catch {
        /* no diff context */
      }
    }

    const run = {
      at: new Date().toISOString(),
      command: opts.command,
      exit: opts.exit,
      symbols: [...symbols],
      failed_tests: failed,
      feature: opts.feature,
      message: opts.message,
    };
    await recordTestRun(root, run);

    if (opts.json) {
      console.log(JSON.stringify(run, null, 2));
      return;
    }
    const tag = opts.exit === 0 ? kleur.green("PASS") : kleur.red("FAIL");
    console.log(
      `${tag} ${kleur.dim(opts.command)} → ${run.symbols.length} symbol(s), ${failed.length} failing test(s)`,
    );
  });
}
