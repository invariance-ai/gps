import type { Command } from "commander";
import kleur from "kleur";
import {
  classifyCorrection,
  classifyLesson,
  persistLesson,
  type ClassifyResult,
  type CorrectionKind,
} from "@invariance/gps-core";
import type { NoteScope, NoteSeverity, ClassifierMeta } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  symbol?: string;
  file?: string;
  feature?: string;
  area?: string;
  global?: boolean;
  evidence?: string;
  severity?: string;
  json?: boolean;
}

function forcedScope(opts: Opts): { scope?: NoteScope; target?: string } {
  if (opts.symbol) return { scope: "symbol", target: opts.symbol };
  if (opts.file) return { scope: "file", target: opts.file };
  if (opts.feature) return { scope: "feature", target: opts.feature };
  if (opts.area) return { scope: "area", target: opts.area };
  if (opts.global) return { scope: "global" };
  return {};
}

function meta(result: ClassifyResult, kind: CorrectionKind): ClassifierMeta {
  return {
    signals: result.signals,
    confidence: result.confidence,
    used_llm: false,
    correction_kind: kind === "general" ? undefined : kind,
  };
}

export function registerRemember(program: Command): void {
  addRootOption(
    program
      .command("remember <fact>")
      .description("Save a hard-won fact without choosing between lessons, notes, or scope")
      .option("--symbol <name>", "Attach to a symbol")
      .option("--file <path>", "Attach to a file")
      .option("--feature <label>", "Attach to a feature")
      .option("--area <dir>", "Attach to an area/directory")
      .option("--global", "Record as a repo-wide lesson")
      .option("--evidence <ref>", "PR/commit/doc backing this fact")
      .option("--severity <level>", "low | medium | high")
      .option("--json", "Emit JSON"),
  ).action(async (fact: string, opts: Opts) => {
    const root = resolveRoot(opts);
    try {
      const correction = classifyCorrection(fact);
      const forced = forcedScope(opts);
      const classified = forced.scope
        ? {
            scope: forced.scope,
            target: forced.target,
            confidence: 1,
            signals: ["remember", "forced", ...correction.signals],
            candidates: { symbols: [], files: [], features: [], areas: [] },
            ambiguous: false,
          } satisfies ClassifyResult
        : await classifyLesson(root, fact);
      classified.signals = [...classified.signals, ...correction.signals];

      const persisted = await persistLesson(root, {
        scope: classified.scope,
        target: classified.target,
        lesson: fact,
        evidence: opts.evidence,
        severity: (opts.severity as NoteSeverity | undefined) ?? correction.severity,
        classifier: meta(classified, correction.kind),
      });

      if (opts.json) {
        console.log(JSON.stringify({ ...persisted, correction_kind: correction.kind }, null, 2));
        return;
      }
      const target = persisted.target ? ` → ${kleur.bold(persisted.target)}` : "";
      console.log(`${kleur.green("remembered")} [${kleur.cyan(persisted.scope)}]${target} ${kleur.dim(persisted.path)}`);
      if (correction.kind !== "general") console.log(kleur.dim(`correction: ${correction.kind}`));
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}
