import type { Command } from "commander";
import kleur from "kleur";
import { autoPromote, findPromotionCandidates, loadPolicy } from "@invariance/gps-core";
import { PromoteMode, type PromoteMode as PromoteModeT } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  min?: string;
  threshold?: string;
  json?: boolean;
  auto?: boolean | string;
  dryRun?: boolean;
}

export function registerPromote(program: Command): void {
  addRootOption(
    program
      .command("promote [symbol]")
      .description(
        "Find clusters of similar un-promoted notes that should become invariants",
      )
      .option(
        "--auto [policy]",
        "Auto-promote per configured policy; override for this run with --auto=safe|never|all",
      )
      .option("--dry-run", "With --auto: show the promotion plan without writing")
      .option("--min <n>", "Minimum cluster size", "3")
      .option("--threshold <f>", "Jaccard similarity threshold (0-1)", "0.4")
      .option("--json", "Emit JSON"),
  ).action(async (symbol: string | undefined, opts: Opts) => {
    const root = resolveRoot(opts);
    if (opts.auto !== undefined) {
      let override: PromoteModeT | undefined;
      if (typeof opts.auto === "string") {
        const parsed = PromoteMode.safeParse(opts.auto);
        if (!parsed.success) {
          console.error(
            kleur.red(`error: invalid --auto value '${opts.auto}' (expected: never|safe|all)`),
          );
          process.exitCode = 1;
          return;
        }
        override = parsed.data;
      }
      await runAuto(root, symbol, opts, override);
      return;
    }
    if (!symbol) {
      console.error(kleur.red("error: missing required argument 'symbol' (or pass --auto)"));
      process.exitCode = 1;
      return;
    }
    try {
      const min = Number.parseInt(opts.min ?? "3", 10);
      const threshold = Number.parseFloat(opts.threshold ?? "0.4");
      const candidates = await findPromotionCandidates(root, symbol, min, threshold);
      if (opts.json) {
        console.log(JSON.stringify(candidates, null, 2));
        return;
      }
      if (candidates.length === 0) {
        console.log(
          kleur.dim(
            `no promotion candidates for ${symbol} (need ≥${min} similar notes; tune --min / --threshold)`,
          ),
        );
        return;
      }
      console.log(kleur.bold(`Promotion candidates for ${symbol}:`));
      console.log("");
      for (const c of candidates) {
        console.log(
          `${kleur.cyan(c.representative_lesson)} ${kleur.dim(`(${c.notes.length} notes, severity hint: ${c.severity_hint})`)}`,
        );
        for (const n of c.notes) {
          console.log(kleur.dim(`  - [${n.severity}] ${n.lesson}`));
        }
        console.log("");
      }
      console.log(
        kleur.dim(
          "Hint: run `gps postmortem --pr <n>` to author a full invariant from a recent regression, or edit .gps/invariants.yml manually.",
        ),
      );
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}

async function runAuto(
  root: string,
  symbol: string | undefined,
  opts: { json?: boolean; dryRun?: boolean },
  override?: PromoteModeT,
): Promise<void> {
  try {
    const promote = override ?? (await loadPolicy(root)).promote;
    if (promote === "never") {
      if (opts.json) {
        console.log(JSON.stringify({ policy: "never", promoted: [], skipped_risk: [] }, null, 2));
        return;
      }
      console.log(
        kleur.dim(
          "auto-promotion is disabled (promote=never). Enable it with `gps install <agent> --capture=auto --promote=safe` (or =all).",
        ),
      );
      return;
    }
    const res = await autoPromote(root, promote, {
      symbols: symbol ? [symbol] : undefined,
      dryRun: opts.dryRun,
    });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    const verb = opts.dryRun ? "would promote" : "promoted";
    if (res.promoted.length === 0 && res.skipped_risk.length === 0) {
      console.log(kleur.dim(`no promotion candidates (policy=${promote})`));
      return;
    }
    for (const p of res.promoted) {
      console.log(
        kleur.green(`${verb}`) +
          ` ${kleur.cyan(p.invariant.rule)} ${kleur.dim(`(${p.from_notes} notes → invariant "${p.invariant.name}", severity ${p.invariant.severity})`)}`,
      );
    }
    for (const s of res.skipped_risk) {
      console.log(
        kleur.yellow(`skipped`) +
          ` ${s.representative_lesson} ${kleur.dim(`— touches: ${s.topics.join(", ")} (needs human review)`)}`,
      );
    }
  } catch (e) {
    console.error(kleur.red(`error: ${(e as Error).message}`));
    process.exitCode = 1;
  }
}
