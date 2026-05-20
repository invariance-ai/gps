import type { Command } from "commander";
import kleur from "kleur";
import {
  classifyLesson,
  persistLesson,
  listLessons,
  reclassifyLesson,
  type ClassifyResult,
} from "@invariance/gps-core";
import { llmClassify } from "@invariance/gps-llm";
import type { NoteScope, NoteSeverity, ClassifierMeta } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface RecordOpts extends RootOption {
  severity?: string;
  evidence?: string;
  hintScope?: string;
  hintTarget?: string;
  forceScope?: string;
  forceTarget?: string;
  dryRun?: boolean;
  noLlm?: boolean;
  json?: boolean;
}

interface ListOpts extends RootOption {
  scope?: string;
  target?: string;
  json?: boolean;
}

interface ReclassifyOpts extends RootOption {
  to: string;
  toTarget?: string;
  json?: boolean;
}

function validScope(s: string | undefined): NoteScope | undefined {
  if (!s) return undefined;
  if (
    s === "global" ||
    s === "symbol" ||
    s === "file" ||
    s === "feature" ||
    s === "area"
  )
    return s;
  return undefined;
}

function classifierMeta(
  h: ClassifyResult,
  used_llm: boolean,
  model?: string,
): ClassifierMeta {
  return {
    signals: h.signals,
    confidence: h.confidence,
    used_llm,
    model,
  };
}

export function registerLessons(program: Command): void {
  const cmd = program.command("lessons").description("Manage tiered repo lessons (global → CLAUDE.md, scoped → .gps/notes/*)");

  addRootOption(
    cmd
      .command("record <lesson>")
      .description("Classify and persist a lesson. Heuristic picks scope; LLM is a tie-breaker.")
      .option("--severity <level>", "low | medium | high", "medium")
      .option("--evidence <ref>", "PR/commit/doc backing this lesson")
      .option("--hint-scope <scope>", "Bias the classifier (global|symbol|file|feature)")
      .option("--hint-target <target>", "Bias the target (symbol name, file path, feature label)")
      .option("--force-scope <scope>", "Skip classification (global|symbol|file|feature)")
      .option("--force-target <target>", "Required when force-scope is symbol|file|feature")
      .option("--dry-run", "Show classification without writing")
      .option("--no-llm", "Disable LLM tie-breaker (heuristic only)")
      .option("--json", "Emit JSON"),
  ).action(async (lesson: string, opts: RecordOpts) => {
    const root = resolveRoot(opts);
    try {
      const forced = validScope(opts.forceScope);
      let scope: NoteScope;
      let target: string | undefined;
      let signals: string[] = [];
      let confidence = 1;
      let used_llm = false;
      let model: string | undefined;

      if (forced) {
        scope = forced;
        target = opts.forceTarget;
        signals = ["forced"];
        if (scope !== "global" && !target) {
          throw new Error(`--force-scope ${scope} requires --force-target`);
        }
      } else {
        const heuristic = await classifyLesson(root, lesson);
        signals = heuristic.signals;
        confidence = heuristic.confidence;
        scope = heuristic.scope;
        target = heuristic.target;

        // Apply hint as a soft override only when heuristic was ambiguous.
        const hintScope = validScope(opts.hintScope);
        if (hintScope && (heuristic.ambiguous || confidence < 0.8)) {
          scope = hintScope;
          target = opts.hintTarget ?? target;
          signals.push("hint-applied");
          confidence = Math.max(confidence, 0.85);
        }

        const shouldCallLlm =
          !opts.noLlm && (heuristic.ambiguous || confidence < 0.8);
        if (shouldCallLlm) {
          const llm = await llmClassify(
            root,
            lesson,
            heuristic.candidates,
            heuristic.signals,
            { scope, target, reason: "heuristic fallback" },
          );
          scope = llm.decision.scope;
          target = llm.decision.target ?? target;
          used_llm = llm.used_llm;
          model = llm.model;
          if (llm.used_llm) signals.push("llm");
        }
      }

      if (opts.dryRun) {
        const out = {
          scope,
          target,
          signals,
          confidence,
          used_llm,
          model,
          dry_run: true,
          path: scope === "global" ? "CLAUDE.md" : `<would-write>`,
          id: "<dry-run>",
        };
        if (opts.json) console.log(JSON.stringify(out, null, 2));
        else console.log(kleur.dim("dry-run:"), out);
        return;
      }

      const meta = classifierMeta(
        { scope, target, signals, confidence, candidates: { symbols: [], files: [], features: [], areas: [] }, ambiguous: false },
        used_llm,
        model,
      );
      const persisted = await persistLesson(root, {
        scope,
        target,
        lesson,
        evidence: opts.evidence,
        severity: (opts.severity as NoteSeverity) ?? "medium",
        classifier: meta,
      });

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ...persisted,
              signals,
              confidence,
              used_llm,
              dry_run: false,
            },
            null,
            2,
          ),
        );
        return;
      }
      const targetStr = target ? ` → ${kleur.bold(target)}` : "";
      console.log(
        `${kleur.green("recorded")} [${kleur.cyan(scope)}]${targetStr} ${kleur.dim(persisted.path)} ${kleur.dim(`(id ${persisted.id})`)}`,
      );
      if (signals.length) console.log(kleur.dim(`signals: ${signals.join(", ")}`));
      if (used_llm) console.log(kleur.dim(`llm: ${model ?? "default"}`));
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });

  addRootOption(
    cmd
      .command("list")
      .description("List recorded lessons across scopes")
      .option("--scope <scope>", "global | symbol | file | feature | area")
      .option("--target <t>", "Filter by target")
      .option("--json", "Emit JSON"),
  ).action(async (opts: ListOpts) => {
    const root = resolveRoot(opts);
    const lessons = await listLessons(root, {
      scope: validScope(opts.scope),
      target: opts.target,
    });
    if (opts.json) {
      console.log(JSON.stringify({ lessons }, null, 2));
      return;
    }
    if (lessons.length === 0) {
      console.log(kleur.dim("no lessons recorded"));
      return;
    }
    for (const l of lessons) {
      const head = `[${kleur.cyan(l.scope)}${l.target ? `:${l.target}` : ""}]`;
      console.log(`${head} ${kleur.dim(l.id)} [${l.severity}] ${l.lesson}`);
      console.log(`   ${kleur.dim(l.path)}`);
    }
  });

  addRootOption(
    cmd
      .command("reclassify <id>")
      .description("Move a lesson between scopes (e.g. promote scoped → global)")
      .requiredOption("--to <scope>", "global | symbol | file | feature | area")
      .option("--to-target <t>", "Required for symbol|file|feature")
      .option("--json", "Emit JSON"),
  ).action(async (id: string, opts: ReclassifyOpts) => {
    const root = resolveRoot(opts);
    const to = validScope(opts.to);
    if (!to) {
      console.error(kleur.red(`--to must be one of: global, symbol, file, feature, area`));
      process.exitCode = 1;
      return;
    }
    try {
      const result = await reclassifyLesson(root, {
        id,
        to_scope: to,
        to_target: opts.toTarget,
      });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else
        console.log(
          `${kleur.green("moved")} ${kleur.dim(id)} ${result.from_scope}${result.from_target ? `:${result.from_target}` : ""} → ${result.to_scope}${result.to_target ? `:${result.to_target}` : ""}`,
        );
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}
