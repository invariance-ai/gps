import type { Command } from "commander";
import kleur from "kleur";
import { pulse } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface PulseOpts extends RootOption {
  base?: string;
  json?: boolean;
  github?: boolean;
}

export function registerPulse(program: Command): void {
  addRootOption(
    program
      .command("pulse")
      .description("Diff-time risk report: invariants, untested callers, notes, decisions, plus a single risk score")
      .option("--base <ref>", "Diff base (default HEAD)", "HEAD")
      .option("--json", "Emit JSON")
      .option("--github", "Emit GitHub PR comment payload (markdown body only)"),
  ).action(async (opts: PulseOpts) => {
    const root = resolveRoot(opts);
    const result = await pulse(root, { base: opts.base });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (opts.github) {
      console.log(result.markdown);
    } else {
      const band = result.risk_band;
      const c = band === "block" ? kleur.red : band === "high" ? kleur.yellow : band === "medium" ? kleur.cyan : kleur.green;
      console.log(c(`risk ${result.risk_score} (${band}) — ${result.findings.length} finding(s) across ${result.changed_files.length} file(s)`));
      console.log("");
      console.log(result.markdown);
    }
    // Non-zero exit on block so CI can fail.
    process.exitCode = result.risk_band === "block" ? 1 : 0;
  });
}
