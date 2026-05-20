import type { Command } from "commander";
import kleur from "kleur";
import { auditSession } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  session?: boolean;
  json?: boolean;
}

export function registerAudit(program: Command): void {
  addRootOption(
    program
      .command("audit")
      .description("Run self-audit checks for the current session")
      .option("--session", "Audit the active session (default)", true)
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    const report = await auditSession(root);
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.checks.every((c) => c.pass) ? 0 : 1;
      return;
    }
    const header = report.session
      ? `session ${report.session.slice(0, 8)} (${report.events} events)`
      : "no active session";
    console.log(kleur.bold(header));
    for (const c of report.checks) {
      const tag = c.pass ? kleur.green("✓") : kleur.red("✗");
      console.log(`  ${tag} ${kleur.cyan(c.id)}  ${kleur.dim(c.detail)}`);
    }
    const failed = report.checks.filter((c) => !c.pass).length;
    if (failed > 0) {
      console.log(kleur.red(`\n${failed} check(s) failed`));
      process.exitCode = 1;
    }
  });
}
