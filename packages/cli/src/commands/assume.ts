import type { Command } from "commander";
import kleur from "kleur";
import {
  appendAssumption,
  loadAssumptions,
  verifyAssumption,
} from "@invariance/gps-core";
import type { AssumptionConfidence } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface AssumeOpts extends RootOption {
  confidence?: string;
  evidence?: string;
  json?: boolean;
}

interface ListOpts extends RootOption {
  unverified?: boolean;
  json?: boolean;
}

interface VerifyOpts extends RootOption {
  evidence?: string;
  json?: boolean;
}

function parseConfidence(v: string | undefined): AssumptionConfidence {
  if (v === "low" || v === "medium" || v === "high") return v;
  if (v === undefined) return "medium";
  throw new Error("--confidence must be low|medium|high");
}

export function registerAssume(program: Command): void {
  const assume = program.command("assume").description("Record/verify assumptions about a symbol");

  addRootOption(
    assume
      .command("add <symbol> <statement>", { isDefault: true })
      .description("Record an unverified assumption")
      .option("--confidence <level>", "low|medium|high", "medium")
      .option("--evidence <text>", "Optional pointer or rationale")
      .option("--json", "Emit JSON"),
  ).action(async (symbol: string, statement: string, opts: AssumeOpts) => {
    const root = resolveRoot(opts);
    try {
      const r = await appendAssumption(root, {
        symbol,
        statement,
        confidence: parseConfidence(opts.confidence),
        evidence: opts.evidence,
      });
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      else console.log(`${kleur.green("recorded")} ${r.assumption.id} → ${r.file}`);
    } catch (e) {
      console.error(kleur.red((e as Error).message));
      process.exitCode = 1;
    }
  });

  addRootOption(
    assume
      .command("verify <symbol> <id>")
      .description("Mark an assumption as verified")
      .option("--evidence <text>", "Evidence supporting verification")
      .option("--json", "Emit JSON"),
  ).action(async (symbol: string, id: string, opts: VerifyOpts) => {
    const root = resolveRoot(opts);
    const updated = await verifyAssumption(root, symbol, id, opts.evidence);
    if (!updated) {
      console.error(kleur.red(`no assumption with id=${id} for ${symbol}`));
      process.exitCode = 1;
      return;
    }
    if (opts.json) console.log(JSON.stringify(updated, null, 2));
    else console.log(`${kleur.green("verified")} ${id}`);
  });

  addRootOption(
    program
      .command("assumptions <symbol>")
      .description("List assumptions recorded for a symbol")
      .option("--unverified", "Only unverified")
      .option("--json", "Emit JSON"),
  ).action(async (symbol: string, opts: ListOpts) => {
    const root = resolveRoot(opts);
    const all = await loadAssumptions(root, symbol);
    const filtered = opts.unverified ? all.filter((a) => !a.verified) : all;
    if (opts.json) {
      console.log(JSON.stringify({ symbol, assumptions: filtered }, null, 2));
      return;
    }
    if (filtered.length === 0) {
      console.log(kleur.dim("no assumptions"));
      return;
    }
    for (const a of filtered) {
      const mark = a.verified ? kleur.green("✓") : kleur.yellow("?");
      console.log(`  ${mark} ${kleur.dim(`[${a.confidence}]`)} ${a.statement}`);
      console.log(`    ${kleur.dim(`id=${a.id}`)}`);
    }
  });
}
