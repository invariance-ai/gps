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
  reminder?: boolean;
  for?: string;
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

function normalizeReminderAudience(value?: string): "agent" | "human" | "both" {
  if (value === undefined) return "agent";
  if (value === "agent" || value === "human" || value === "both") return value;
  throw new Error('--for must be one of: agent, human, both');
}

function reminderLesson(fact: string, audience: "agent" | "human" | "both"): string {
  const trimmed = fact.trim();
  if (/^reminder\s+for\s+/i.test(trimmed)) return trimmed;
  const who = audience === "both" ? "next agent and human" : `next ${audience}`;
  return `Reminder for ${who}: ${trimmed}`;
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
      .option("--reminder", "Record a pending reminder / still-to-do item for the next agent or human")
      .option("--for <audience>", "Reminder audience: agent | human | both (default: agent)")
      .option("--evidence <ref>", "PR/commit/doc backing this fact")
      .option("--severity <level>", "low | medium | high")
      .option("--json", "Emit JSON"),
  ).action(async (fact: string, opts: Opts) => {
    const root = resolveRoot(opts);
    try {
      const audience = opts.reminder ? normalizeReminderAudience(opts.for) : undefined;
      const lesson = opts.reminder ? reminderLesson(fact, audience ?? "agent") : fact;
      const correction = classifyCorrection(lesson);
      const forced = forcedScope(opts);
      const classified = forced.scope
        ? {
            scope: forced.scope,
            target: forced.target,
            confidence: 1,
            signals: ["remember", "forced", ...(opts.reminder ? ["reminder", `reminder:${audience}`] : []), ...correction.signals],
            candidates: { symbols: [], files: [], features: [], areas: [] },
            ambiguous: false,
          } satisfies ClassifyResult
        : await classifyLesson(root, lesson);
      classified.signals = [
        ...classified.signals,
        ...(opts.reminder ? ["remember", "reminder", `reminder:${audience}`] : []),
        ...correction.signals,
      ];

      const persisted = await persistLesson(root, {
        scope: classified.scope,
        target: classified.target,
        lesson,
        evidence: opts.evidence,
        severity: (opts.severity as NoteSeverity | undefined) ?? (opts.reminder ? "high" : correction.severity),
        classifier: meta(classified, correction.kind),
      });

      if (opts.json) {
        console.log(JSON.stringify({ ...persisted, correction_kind: correction.kind, reminder: !!opts.reminder, audience }, null, 2));
        return;
      }
      const target = persisted.target ? ` → ${kleur.bold(persisted.target)}` : "";
      console.log(`${kleur.green("remembered")} [${kleur.cyan(persisted.scope)}]${target} ${kleur.dim(persisted.path)}`);
      if (opts.reminder) console.log(kleur.dim(`reminder: ${audience}`));
      if (correction.kind !== "general") console.log(kleur.dim(`correction: ${correction.kind}`));
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}
