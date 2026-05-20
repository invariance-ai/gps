import type { Command } from "commander";
import kleur from "kleur";
import { allFeatureHealth, featureHealth } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  feature?: string;
  all?: boolean;
  json?: boolean;
}

function renderOne(h: NonNullable<Awaited<ReturnType<typeof featureHealth>>>) {
  const pct = (h.score * 100).toFixed(0);
  const tone = h.score >= 0.7 ? kleur.green : h.score >= 0.4 ? kleur.yellow : kleur.red;
  console.log(`${kleur.bold(h.feature)}  ${tone(`score ${pct}%`)}`);
  console.log(`  symbols: ${h.symbols}`);
  console.log(`  invariants: ${h.invariants}`);
  console.log(`  notes: ${h.notes} ${kleur.dim(`(${h.notes_stale} stale)`)}`);
  console.log(`  decisions: ${h.decisions}`);
  console.log(`  open questions: ${h.open_questions} ${kleur.dim(`(${h.open_questions_old} >30d)`)}`);
  console.log(
    `  assumptions: ${h.assumptions} ${kleur.dim(`(${h.unverified_assumptions} unverified)`)}`,
  );
  console.log(`  conflicts: ${h.conflicts}`);
  console.log(`  last_active: ${kleur.dim(h.last_active)}`);
}

export function registerHealth(program: Command): void {
  addRootOption(
    program
      .command("health")
      .description("Knowledge-layer health for one feature or all features")
      .option("--feature <label>", "Feature label to score")
      .option("--all", "List every feature")
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    if (opts.all || !opts.feature) {
      const all = await allFeatureHealth(root);
      if (opts.json) {
        console.log(JSON.stringify(all, null, 2));
        return;
      }
      if (all.length === 0) {
        console.log(kleur.dim("no features tracked yet"));
        return;
      }
      for (const h of all) {
        const pct = (h.score * 100).toFixed(0);
        const tone = h.score >= 0.7 ? kleur.green : h.score >= 0.4 ? kleur.yellow : kleur.red;
        console.log(
          `  ${tone(`${pct.padStart(3)}%`)} ${kleur.bold(h.feature.padEnd(20))} ${kleur.dim(`symbols=${h.symbols} inv=${h.invariants} notes=${h.notes} q=${h.open_questions} conf=${h.conflicts}`)}`,
        );
      }
      return;
    }
    const h = await featureHealth(root, opts.feature);
    if (!h) {
      console.error(kleur.red(`feature not found: ${opts.feature}`));
      process.exitCode = 1;
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(h, null, 2));
      return;
    }
    renderOne(h);
  });
}
