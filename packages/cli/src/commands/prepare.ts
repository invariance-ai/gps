import type { Command } from "commander";
import kleur from "kleur";
import { prepareEdit, recordPrepared, inferSymbols, topSymbols } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface PrepareOpts extends RootOption {
  intent: string;
  json?: boolean;
  budget?: string;
  since?: string;
  depth?: string;
  fromPrompt?: string;
  feature?: string;
}

export function registerPrepare(program: Command): void {
  addRootOption(
    program
      .command("prepare [symbol]")
      .description("Decision-ready brief before editing a symbol (calls prepare_edit)")
      .option("--intent <text>", "What you plan to change", "(unspecified)")
      .option("--budget <tokens>", "Approximate token budget for the brief")
      .option("--since <when>", "Drop notes/decisions/questions older than this (ISO or 7d/2w/3mo)")
      .option("--depth <n>", "Neighborhood depth for callee context (1-3)")
      .option("--from-prompt <text>", "Infer the symbol from a natural-language prompt")
      .option("--feature <label>", "Use the feature's top symbol when no symbol is given")
      .option("--json", "Emit JSON instead of markdown"),
  ).action(async (symbolArg: string | undefined, opts: PrepareOpts) => {
    try {
      const root = resolveRoot(opts);
      const budget = opts.budget ? Number(opts.budget) : undefined;
      const depth = opts.depth ? Number(opts.depth) : undefined;
      if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) {
        throw new Error("--budget must be a positive integer");
      }
      if (depth !== undefined && (!Number.isInteger(depth) || depth < 1 || depth > 3)) {
        throw new Error("--depth must be 1, 2, or 3");
      }

      let symbol = symbolArg;
      // --from-prompt is now an alias of --intent; keep both for backcompat.
      const intentText = (opts.fromPrompt && opts.fromPrompt.trim())
        || (opts.intent && opts.intent !== "(unspecified)" ? opts.intent : undefined);
      let candidates: Array<{ symbol: string; score: number; via: string }> = [];
      let pickedVia: string | undefined;
      let pickedScore: number | undefined;
      let lowConfidence = false;
      // Intent wins over --feature when its top match is high-confidence (>=85).
      // Otherwise --feature wins (existing behavior). This lets natural-language
      // intent narrow a feature to the right symbol without overriding when
      // confidence is mediocre.
      const INTENT_OVERRIDES_FEATURE = 85;
      let intentMatchesAttempted = false;
      if (!symbol && intentText) {
        const matches = await inferSymbols(root, intentText, { limit: 5 });
        intentMatchesAttempted = true;
        if (matches.length > 0) {
          candidates = matches.map((m) => ({
            symbol: m.symbol.qualified_name ?? m.symbol.name,
            score: m.score,
            via: m.via,
          }));
          const top = matches[0]!;
          if (!opts.feature || top.score >= INTENT_OVERRIDES_FEATURE) {
            symbol = top.symbol.qualified_name ?? top.symbol.name;
            pickedVia = top.via;
            pickedScore = top.score;
            const LOW_CONFIDENCE_THRESHOLD = 70;
            lowConfidence = candidates.length === 1 && top.score < LOW_CONFIDENCE_THRESHOLD;
          }
        }
      }
      if (!symbol && opts.feature) {
        const top = await topSymbols(root, opts.feature, 1);
        if (top.length === 0) throw new Error(`feature "${opts.feature}" has no symbols (run \`gps feature attribute\` first)`);
        const id = top[0]!.id;
        const hash = id.indexOf("#");
        const tail = hash >= 0 ? id.slice(hash + 1) : id;
        const colon = tail.lastIndexOf(":");
        symbol = colon > 0 ? tail.slice(0, colon) : tail;
        pickedVia = "feature-top";
        if (!opts.json) {
          console.error(kleur.dim(`using top symbol "${symbol}" from feature "${opts.feature}"`));
        }
      }
      if (!symbol && intentText && intentMatchesAttempted && candidates.length === 0) {
        throw new Error(`no symbol matches for intent; try \`gps plan "${intentText}"\``);
      }
      if (!symbol) {
        throw new Error("symbol is required (or pass --intent <text> / --feature <label>)");
      }
      if (pickedVia && pickedScore !== undefined && !opts.json) {
        console.error(
          kleur.dim(`inferred symbol "${symbol}" (confidence ${pickedScore}, via ${pickedVia}) from intent`),
        );
        if (lowConfidence) {
          console.error(
            kleur.yellow(
              `warning: only one candidate matched and confidence is low (${pickedScore}/100). ` +
              `Consider passing the symbol explicitly as a positional arg.`,
            ),
          );
        }
        if (candidates.length > 1) {
          const others = candidates.slice(1, 4)
            .map((c) => `${c.symbol} (${c.score})`).join(", ");
          console.error(kleur.dim(`other candidates: ${others}`));
        }
      }

      const r = await prepareEdit(
        {
          symbol,
          intent: opts.intent,
          budget,
          since: opts.since,
          depth,
          // Pass inferred alternates so core can surface a "did you mean" hint
          // when the resolved symbol is weak (zero callers / low confidence).
          ...(candidates.length > 0 ? { candidates } : {}),
        },
        root,
      );
      await recordPrepared(root, symbol).catch(() => {});
      const withCandidates = candidates.length > 1
        ? { ...r, candidates, ...(lowConfidence ? { low_confidence: true } : {}) }
        : (lowConfidence ? { ...r, low_confidence: true } : r);
      if (opts.json) console.log(JSON.stringify(withCandidates, null, 2));
      else {
        console.log(r.markdown);
        if (pickedVia) {
          console.log(`\n_picked symbol via_ \`${pickedVia}\`${pickedScore !== undefined ? ` (score ${pickedScore})` : ""}`);
        }
        if (candidates.length > 1) {
          console.log("\n## Candidates");
          for (const c of candidates) console.log(`- ${c.symbol} (score=${c.score}, via=${c.via})`);
          console.log(kleur.dim("\nPass the symbol name directly to lock the choice."));
        }
        console.log(kleur.dim("\n→ Run `gps brief` after editing to verify changed symbols, invariants, notes, and tests."));
      }
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}
