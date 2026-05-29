import type { Command } from "commander";
import kleur from "kleur";
import {
  classifyCorrection,
  classifyLesson,
  persistLesson,
  type ClassifyResult,
  type CorrectionKind,
} from "@invariance/gps-core";
import type { ClassifierMeta, NoteScope, NoteSeverity } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  symbol?: string;
  file?: string;
  feature?: string;
  area?: string;
  global?: boolean;
  evidence?: string;
  severity?: string;
  yes?: boolean;
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

function quote(value: string): string {
  return JSON.stringify(value);
}

function rememberCommand(fact: string, opts: Opts, classified?: ClassifyResult): string {
  const parts = ["gps remember", quote(fact)];
  const forced = forcedScope(opts);
  const scope = forced.scope ?? classified?.scope;
  const target = forced.target ?? classified?.target;
  if (scope === "symbol" && target) parts.push("--symbol", quote(target));
  else if (scope === "file" && target) parts.push("--file", quote(target));
  else if (scope === "feature" && target) parts.push("--feature", quote(target));
  else if (scope === "area" && target) parts.push("--area", quote(target));
  else if (scope === "global") parts.push("--global");
  if (opts.evidence) parts.push("--evidence", quote(opts.evidence));
  if (opts.severity) parts.push("--severity", quote(opts.severity));
  return parts.join(" ");
}

function meta(result: ClassifyResult, kind: CorrectionKind): ClassifierMeta {
  return {
    signals: result.signals,
    confidence: result.confidence,
    used_llm: false,
    correction_kind: kind === "general" ? undefined : kind,
  };
}

export function registerSaveThis(program: Command): void {
  addRootOption(
    program
      .command("save-this <fact>")
      .description("Preview or save a reusable correction/finding as GPS memory")
      .option("--symbol <name>", "Attach to a symbol")
      .option("--file <path>", "Attach to a file")
      .option("--feature <label>", "Attach to a feature")
      .option("--area <dir>", "Attach to an area/directory")
      .option("--global", "Record as a repo-wide lesson")
      .option("--evidence <ref>", "PR/commit/doc backing this fact")
      .option("--severity <level>", "low | medium | high")
      .option("--yes", "Persist immediately instead of printing the save command")
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
            signals: ["save-this", "forced", ...correction.signals],
            candidates: { symbols: [], files: [], features: [], areas: [] },
            ambiguous: false,
          } satisfies ClassifyResult
        : await classifyLesson(root, fact);
      const command = rememberCommand(fact, opts, classified);
      if (!opts.yes) {
        const result = {
          save: false,
          command,
          scope: classified.scope,
          target: classified.target,
          confidence: classified.confidence,
          correction_kind: correction.kind,
        };
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(kleur.bold("Save this as GPS memory?"));
        console.log(`  ${kleur.cyan(command)}`);
        console.log(kleur.dim(`scope=${classified.scope}${classified.target ? ` target=${classified.target}` : ""}, confidence=${classified.confidence}`));
        console.log(kleur.dim("Add --yes to save it now, or edit the command first."));
        return;
      }

      const persisted = await persistLesson(root, {
        scope: classified.scope,
        target: classified.target,
        lesson: fact,
        evidence: opts.evidence,
        severity: (opts.severity as NoteSeverity | undefined) ?? correction.severity,
        classifier: meta(classified, correction.kind),
      });
      if (opts.json) {
        console.log(JSON.stringify({ save: true, command, ...persisted, correction_kind: correction.kind }, null, 2));
        return;
      }
      const target = persisted.target ? ` -> ${kleur.bold(persisted.target)}` : "";
      console.log(`${kleur.green("saved")} [${kleur.cyan(persisted.scope)}]${target} ${kleur.dim(persisted.path)}`);
      console.log(kleur.dim("Next relevant `gps prepare` calls can surface this memory."));
    } catch (err) {
      console.error(kleur.red(`error: ${(err as Error).message}`));
      process.exitCode = 1;
    }
  });
}
