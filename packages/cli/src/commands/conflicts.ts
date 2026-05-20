import type { Command } from "commander";
import kleur from "kleur";
import { findConflicts, open as openQuery, resolveSymbol } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  json?: boolean;
  failOnConflict?: boolean;
}

export function registerConflicts(program: Command): void {
  addRootOption(
    program
      .command("conflicts <symbol>")
      .description("Detect potential contradictions between invariants, decisions, and notes")
      .option("--fail-on-conflict", "Exit 1 if any conflict is found")
      .option("--json", "Emit JSON"),
  ).action(async (symbol: string, opts: Opts) => {
    const root = resolveRoot(opts);
    const ctx = await openQuery(root);
    const sym = resolveSymbol(symbol, ctx);
    const key = sym?.qualified_name ?? sym?.name ?? symbol;
    const conflicts = await findConflicts(root, key);
    if (opts.json) {
      console.log(JSON.stringify({ symbol: key, conflicts }, null, 2));
    } else if (conflicts.length === 0) {
      console.log(kleur.dim(`no conflicts detected for ${key}`));
    } else {
      console.log(kleur.bold(`${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} for ${key}`));
      for (const c of conflicts) {
        const label = c.kind === "contradicts" ? kleur.red(c.kind) : c.kind === "supersedes" ? kleur.yellow(c.kind) : kleur.dim(c.kind);
        console.log(`  ${label}: ${c.summary}`);
        console.log(`    ${kleur.dim(c.lhs.type)}: ${c.lhs.text}`);
        console.log(`    ${kleur.dim(c.rhs.type)}: ${c.rhs.text}`);
      }
    }
    if (opts.failOnConflict && conflicts.length > 0) process.exitCode = 1;
  });
}
