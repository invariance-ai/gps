import type { Command } from "commander";
import kleur from "kleur";
import {
  filterByStatus,
  invariantsFor,
  isGitRepo,
  loadDecisions,
  loadFeatures,
  loadInvariants,
  loadNotes,
  loadQuestions,
  logForFile,
  open as openQuery,
  rankDecisions,
  rankNotes,
  resolveSymbol,
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface WhyOpts extends RootOption {
  json?: boolean;
}

/**
 * One-shot human-facing answer about a symbol: last edit, decision (+ rejected
 * alt), unresolved questions, invariants, feature membership. Pure aggregation
 * over existing primitives — no new storage.
 */
export function registerWhy(program: Command): void {
  addRootOption(
    program
      .command("why <symbol>")
      .description("Everything gps knows about a symbol, in one answer")
      .option("--json", "Emit JSON"),
  ).action(async (symbol: string, opts: WhyOpts) => {
    const root = resolveRoot(opts);
    const ctx = await openQuery(root);
    const sym = resolveSymbol(symbol, ctx);
    if (!sym) {
      if (opts.json) console.log(JSON.stringify({ symbol, found: false }));
      else console.error(kleur.red(`symbol not found: ${symbol}`));
      process.exitCode = 1;
      return;
    }
    const symbolKey = sym.qualified_name ?? sym.name;

    const [provenance, decisions, questions, invariants, features] = await Promise.all([
      (async () => ((await isGitRepo(root)) ? logForFile(root, sym.file, 1) : []))(),
      loadDecisions(root, symbolKey),
      loadQuestions(root, symbolKey),
      (async () => invariantsFor(symbolKey, await loadInvariants(root)))(),
      loadFeatures(root),
    ]);
    const notes = await loadNotes(root, symbolKey);

    const featureHits: Array<{ label: string; weight: number }> = [];
    for (const f of Object.values(features.features)) {
      for (const fs of f.symbols) {
        if (fs.id === sym.id || fs.id.endsWith(`#${symbolKey}:${sym.line}`)) {
          featureHits.push({ label: f.label, weight: fs.weight });
          break;
        }
      }
    }
    featureHits.sort((a, b) => b.weight - a.weight);

    const lastDecision = rankDecisions(decisions, 1)[0];
    const unresolved = filterByStatus(questions, "unresolved");
    const rankedNotes = rankNotes(notes, 3, false);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            symbol: symbolKey,
            file: sym.file,
            line: sym.line,
            last_commit: provenance[0],
            decision: lastDecision,
            unresolved_questions: unresolved,
            invariants,
            notes: rankedNotes,
            features: featureHits,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(kleur.bold(symbolKey) + kleur.dim(`  ${sym.file}:${sym.line}`));
    const last = provenance[0];
    if (last) {
      console.log(
        `  ${kleur.cyan("last edited:")} ${last.commit} (${last.author}, ${last.date.slice(0, 10)})`,
      );
      console.log(`  ${kleur.cyan("reason:")} ${last.message}`);
    }
    if (lastDecision) {
      console.log(`  ${kleur.cyan("decision:")} ${lastDecision.decision}`);
      if (lastDecision.rejected_alternative) {
        console.log(`  ${kleur.cyan("rejected:")} ${lastDecision.rejected_alternative}`);
      }
      if (lastDecision.rationale) {
        console.log(`  ${kleur.cyan("rationale:")} ${lastDecision.rationale}`);
      }
    }
    if (unresolved.length > 0) {
      console.log(`  ${kleur.cyan("open questions:")}`);
      for (const q of unresolved) {
        console.log(`    ${kleur.yellow("?")} ${q.question}`);
      }
    }
    if (invariants.length > 0) {
      console.log(`  ${kleur.cyan("invariants:")}`);
      for (const inv of invariants) {
        console.log(`    ${kleur.dim(`[${inv.severity}]`)} ${inv.rule}`);
      }
    }
    if (rankedNotes.length > 0) {
      console.log(`  ${kleur.cyan("notes:")}`);
      for (const n of rankedNotes) {
        console.log(`    ${kleur.dim(`[${n.severity}]`)} ${n.lesson}`);
      }
    }
    if (featureHits.length > 0) {
      const head = featureHits[0]!;
      console.log(
        `  ${kleur.cyan("feature:")} ${kleur.bold(head.label)} ${kleur.dim(`(weight: ${head.weight.toFixed(2)})`)}` +
          (featureHits.length > 1
            ? kleur.dim(
                `  +${featureHits
                  .slice(1)
                  .map((f) => `${f.label}:${f.weight.toFixed(2)}`)
                  .join(", ")}`,
              )
            : ""),
      );
    }
  });
}
