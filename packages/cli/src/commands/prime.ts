import type { Command } from "commander";
import kleur from "kleur";
import {
  loadPreferences,
  loadInvariants,
  loadAllDecisions,
  rankDecisions,
  filterExpiredDecisions,
  readGlobalLessons,
  packByBudget,
  estimateTokens,
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface PrimeOpts extends RootOption {
  budget?: string;
  json?: boolean;
  quiet?: boolean;
}

/** Default budget for the session primer — small on purpose; this loads every session. */
const DEFAULT_BUDGET = 600;
const SEV_ORDER: Record<"block" | "warn" | "info", number> = { block: 0, warn: 1, info: 2 };

export function registerPrime(program: Command): void {
  addRootOption(
    program
      .command("prime")
      .description(
        "Compact, budgeted standing context for session start: preferences, blocking invariants, recent decisions, global lessons",
      )
      .option("--budget <tokens>", "Approximate token budget", String(DEFAULT_BUDGET))
      .option("--quiet", "Suppress the token-footprint footer")
      .option("--json", "Emit JSON instead of markdown"),
  ).action(async (opts: PrimeOpts) => {
    try {
      const root = resolveRoot(opts);
      const budget = opts.budget ? Number(opts.budget) : DEFAULT_BUDGET;
      if (!Number.isFinite(budget) || budget <= 0) {
        throw new Error("--budget must be a positive integer");
      }

      const [prefs, invariants, allDecisions, lessons] = await Promise.all([
        loadPreferences(root),
        loadInvariants(root),
        loadAllDecisions(root),
        readGlobalLessons(root),
      ]);

      // Only gating invariants belong in a primer (info is noise); block first.
      const gating = invariants
        .filter((i) => i.severity === "block" || i.severity === "warn")
        .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
      const recentDecisions = rankDecisions(filterExpiredDecisions(allDecisions), 5);

      // Priority order — packByBudget drops later sections first under pressure.
      const sections = [
        {
          heading: "## Standing preferences",
          items: prefs.map((p) => `- ${p.text}${p.topic ? ` [${p.topic}]` : ""}`),
        },
        {
          heading: "## Invariants to respect",
          items: gating.map((i) => `- [${i.severity}] ${i.name}: ${i.rule}`),
        },
        {
          heading: "## Recent decisions",
          items: recentDecisions.map((d) => `- ${d.symbol}: ${d.decision}`),
        },
        { heading: "## Global lessons", items: lessons.map((l) => `- ${l.lesson}`) },
      ];

      const packed = packByBudget(sections, budget);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              preferences: prefs,
              invariants: gating,
              decisions: recentDecisions,
              lessons,
              markdown: packed.text.trimEnd(),
              tokens: {
                estimated: estimateTokens(packed.text),
                kept: packed.kept,
                dropped: packed.dropped,
              },
            },
            null,
            2,
          ),
        );
        return;
      }

      const body = packed.text.trim();
      if (!body) {
        console.log(
          kleur.dim(
            "gps: no standing context yet — capture preferences/decisions/invariants as you work",
          ),
        );
        return;
      }
      console.log(body);
      if (!opts.quiet) {
        console.log(
          kleur.dim(
            `\ngps: primed session with ~${estimateTokens(packed.text)} tokens of standing context`,
          ),
        );
      }
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}
