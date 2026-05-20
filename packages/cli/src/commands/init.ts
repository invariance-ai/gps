import type { Command } from "commander";
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import kleur from "kleur";
import { stringify as yamlStringify } from "yaml";
import { seed, ALL_SOURCE_GLOBS, SEED_TIERS, SEED_TIER_DEFAULTS, type SeedTier } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

const CONFIG = `languages: [typescript, python]
exclude:
  - node_modules
  - dist
  - build
  - .next
  - vendor
  - __pycache__
  - .venv
depth: 3
strands:
  - structural
  - tests
  - provenance
  - invariants
`;

const INVARIANTS = `# .gps/invariants.yml — declarative constraints for symbols in your repo.
# Agents calling \`invariants_for(symbol)\` will receive matching rules with
# evidence *before* they edit, so they can avoid violating them.

- name: Example — high-value refunds require approval
  applies_to:
    - createRefund
    - "stripe.refunds.create"
  rule: Refunds over 1000 require finance_approval_id.
  evidence:
    - docs/refund-policy.md
  severity: block
`;

export interface InitOpts {
  force?: boolean;
}

export interface InitResult {
  writes: Array<{ action: "wrote" | "exists"; relPath: string }>;
}

export async function runInitCore(root: string, opts: InitOpts): Promise<InitResult> {
  const gpsDir = path.join(root, ".gps");
  await mkdir(gpsDir, { recursive: true });
  const writes: InitResult["writes"] = [];
  const targets: Array<[string, string]> = [
    [path.join(gpsDir, "config.yml"), CONFIG],
    [path.join(gpsDir, "invariants.yml"), INVARIANTS],
  ];
  for (const [p, content] of targets) {
    const rel = path.relative(root, p);
    if (!opts.force) {
      try {
        await access(p);
        writes.push({ action: "exists", relPath: rel });
        continue;
      } catch {
        /* doesn't exist, fall through */
      }
    }
    await writeFile(p, content);
    writes.push({ action: "wrote", relPath: rel });
  }
  return { writes };
}

export interface SeedSample {
  kind: string;
  text: string;
  source: string;
  confidence: number;
  applies_to?: string[];
}

export async function seedCandidates(
  root: string,
  tier: SeedTier,
): Promise<{ count: number; path: string; sample: SeedSample[] }> {
  const cfg = SEED_TIER_DEFAULTS[tier];
  const result = await seed(root, {
    maxCommits: cfg.maxCommits,
    maxPrs: cfg.maxPrs,
    scanFiles: ALL_SOURCE_GLOBS,
  });
  const filtered = result.proposals.filter(
    (p) => (p.confidence ?? 0) >= cfg.minConfidence && (cfg.sources as readonly string[]).includes(p.source),
  );
  const notes = filtered.filter((p) => p.kind === "note");
  const invariants = filtered.filter((p) => p.kind === "invariant");
  const dir = path.join(root, ".gps/candidates");
  await mkdir(dir, { recursive: true });
  const out = path.join(dir, "seed-" + new Date().toISOString().replace(/[:.]/g, "-") + ".yml");
  await writeFile(out, yamlStringify({
    tier,
    generated_at: new Date().toISOString(),
    scanned: result.scanned,
    notes,
    invariants,
  }));
  const sample = [...filtered]
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, 3)
    .map((p) => ({
      kind: p.kind,
      text: p.text,
      source: p.source,
      confidence: p.confidence ?? 0,
      applies_to: p.applies_to,
    }));
  return { count: filtered.length, path: path.relative(root, out), sample };
}

export function registerInit(program: Command): void {
  addRootOption(
    program
      .command("init")
      .description("Initialize .gps/ in this directory (config + invariants)")
      .option("--force", "Overwrite existing files")
      .option("--seed [tier]", "Mine repo history for candidate notes/invariants (safe|medium|aggressive, default safe)"),
  ).action(async (opts: RootOption & { force?: boolean; seed?: boolean | string }) => {
    const root = resolveRoot(opts);
    const result = await runInitCore(root, { force: !!opts.force });
    for (const w of result.writes) {
      if (w.action === "wrote") console.log(kleur.green("wrote   ") + w.relPath);
      else console.log(kleur.dim(`exists  ${w.relPath}  (use --force to overwrite)`));
    }
    if (opts.seed) {
      let tier: SeedTier = "safe";
      if (typeof opts.seed === "string") {
        if (!(SEED_TIERS as readonly string[]).includes(opts.seed)) {
          console.error(
            kleur.red(`error: invalid --seed tier "${opts.seed}"; valid values: ${SEED_TIERS.join(", ")}`),
          );
          process.exitCode = 1;
          return;
        }
        tier = opts.seed as SeedTier;
      }
      console.log(kleur.dim(`\nmining seed candidates (tier=${tier})…`));
      const r = await seedCandidates(root, tier);
      console.log(kleur.green(`wrote   `) + r.path + kleur.dim(`  (${r.count} candidates)`));
      if (r.sample.length > 0) {
        console.log(kleur.dim(`\nTop ${r.sample.length} sample (by confidence):`));
        for (const s of r.sample) {
          const tgt = s.applies_to && s.applies_to.length > 0 ? ` [${s.applies_to.join(", ")}]` : "";
          const text = s.text.length > 80 ? s.text.slice(0, 77) + "…" : s.text;
          console.log(
            "  " + kleur.cyan(s.kind) + " " +
            kleur.dim(`(${s.source}, conf ${s.confidence.toFixed(2)})`) +
            kleur.bold(tgt) + " — " + text,
          );
        }
      }
      console.log(kleur.yellow(`\nnote: candidates are written to .gps/candidates/ for manual review — they are NOT auto-promoted.`));
      console.log(kleur.dim(`Next: open ${r.path} to review, then run \`gps seed --apply\` to promote into .gps/notes and .gps/decisions.`));
    }
    console.log("");
    console.log(`Next: ${kleur.bold("gps wizard")} to wire agents, or ${kleur.bold("gps index")} to build the symbol graph.`);
  });
}
