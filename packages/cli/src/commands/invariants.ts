import type { Command } from "commander";
import kleur from "kleur";
import {
  loadInvariants,
  invariantsFor,
  formatInvariantsPretty,
  topSymbols,
  diffSymbols,
  type TopSymbol,
} from "@invariance/gps-core";
import type { Invariant } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface InvOpts extends RootOption {
  json?: boolean;
  feature?: string;
  limit?: number;
  diff?: boolean;
  base?: string;
}

export function registerInvariants(program: Command): void {
  addRootOption(
    program
      .command("invariants [symbol]")
      .description("Invariants that apply to a symbol (or list all)")
      .option("--json", "Emit JSON instead of pretty output")
      .option(
        "--feature <label>",
        "Sort/filter invariants by relevance to a feature's weight bag",
      )
      .option("--limit <n>", "When --feature is set, cap top symbols read", (v) => parseInt(v, 10), 50)
      .option("--diff", "List invariants that apply to symbols in the working-tree diff")
      .option("--base <ref>", "Diff base (default HEAD)", "HEAD"),
  ).action(async (symbol: string | undefined, opts: InvOpts) => {
    const root = resolveRoot(opts);
    const all = await loadInvariants(root);

    if (opts.diff) {
      const { base, symbols } = await diffSymbols(root, opts.base ?? "HEAD");
      const seen = new Map<string, { invariant: Invariant; symbols: string[] }>();
      for (const s of symbols) {
        const id = s.qualified_name ?? s.name;
        for (const inv of invariantsFor(id, all)) {
          const e = seen.get(inv.name) ?? { invariant: inv, symbols: [] };
          if (!e.symbols.includes(id)) e.symbols.push(id);
          seen.set(inv.name, e);
        }
      }
      const ranked = [...seen.values()];
      if (opts.json) {
        console.log(JSON.stringify({ base, invariants: ranked }, null, 2));
        return;
      }
      if (ranked.length === 0) {
        console.log(kleur.dim(`no invariants apply to changed symbols (vs ${base})`));
        return;
      }
      console.log(kleur.bold(`${ranked.length} invariant(s) apply to changed symbols:`));
      for (const r of ranked) {
        console.log(`  ${kleur.cyan(r.invariant.name)} ${kleur.dim(`[${r.invariant.severity}]`)} — ${r.invariant.rule}`);
        console.log(kleur.dim(`    symbols: ${r.symbols.slice(0, 5).join(", ")}${r.symbols.length > 5 ? "…" : ""}`));
      }
      return;
    }

    if (opts.feature) {
      const top = await topSymbols(root, opts.feature, opts.limit ?? 50);
      const ranked = rankInvariantsByFeature(all, top);
      if (opts.json) {
        console.log(JSON.stringify({ feature: opts.feature, invariants: ranked }, null, 2));
        return;
      }
      if (ranked.length === 0) {
        console.log(kleur.dim(`no invariants matched against ${opts.feature}'s symbols`));
        return;
      }
      console.log(kleur.bold(`invariants ranked by ${opts.feature} weight:`));
      for (const r of ranked) {
        const w = r.weight.toFixed(2);
        const color = r.weight >= 0.5 ? kleur.green : r.weight >= 0.2 ? kleur.yellow : kleur.dim;
        console.log(`  ${color(w)}  ${kleur.cyan(r.invariant.name)} ${kleur.dim(`[${r.invariant.severity}]`)} — ${r.invariant.rule}`);
      }
      return;
    }

    const filtered = symbol ? invariantsFor(symbol, all) : all;
    if (opts.json) {
      console.log(JSON.stringify({ symbol: symbol ?? null, invariants: filtered }, null, 2));
      return;
    }
    if (!symbol) {
      if (all.length === 0) {
        console.log(kleur.dim("No invariants declared. Add some to .gps/invariants.yml."));
        return;
      }
      console.log(kleur.bold(`${all.length} invariant(s) declared:`));
      for (const inv of all) console.log(`  - ${kleur.cyan(inv.name)} ${kleur.dim(`[${inv.severity}]`)}`);
      return;
    }
    console.log(formatInvariantsPretty(symbol, filtered));
  });
}

interface RankedInvariant {
  invariant: Invariant;
  weight: number;
  evidence_symbol?: string;
}

function rankInvariantsByFeature(
  invariants: Invariant[],
  top: TopSymbol[],
): RankedInvariant[] {
  const out: RankedInvariant[] = [];
  for (const inv of invariants) {
    let best = 0;
    let evidence: string | undefined;
    for (const s of top) {
      if (inv.applies_to.some((p: string) => matches(s.id, p))) {
        if (s.weight > best) {
          best = s.weight;
          evidence = s.id;
        }
      }
    }
    if (best > 0) out.push({ invariant: inv, weight: best, evidence_symbol: evidence });
  }
  return out.sort((a, b) => b.weight - a.weight);
}

function matches(symbol: string, pattern: string): boolean {
  if (pattern === symbol) return true;
  if (pattern.endsWith("*")) return symbol.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith("*")) return symbol.endsWith(pattern.slice(1));
  return symbol.endsWith("." + pattern) || symbol.endsWith("/" + pattern);
}
