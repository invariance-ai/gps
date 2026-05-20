import type { Command } from "commander";
import path from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import kleur from "kleur";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { seed } from "@invariance/gps-core";
import type { SeedProposal } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface SeedOpts extends RootOption {
  prs?: string;
  commits?: string;
  apply?: boolean;
  json?: boolean;
}

export function registerSeed(program: Command): void {
  addRootOption(
    program
      .command("seed")
      .description("Bootstrap proposed notes/decisions from git log + gh PRs. Writes to .gps/proposals.yml unless --apply.")
      .option("--commits <n>", "Number of commits to scan", "200")
      .option("--prs <n>", "Number of merged PRs to scan", "50")
      .option("--apply", "Append to .gps/notes and .gps/decisions instead of writing to proposals.yml", false)
      .option("--json", "Emit JSON"),
  ).action(async (opts: SeedOpts) => {
    const root = resolveRoot(opts);
    const result = await seed(root, {
      maxCommits: Number(opts.commits ?? "200"),
      maxPrs: Number(opts.prs ?? "50"),
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(
      kleur.dim(
        `scanned ${result.scanned.commits} commit(s), ${result.scanned.prs} PR(s) — ${result.proposals.length} proposal(s)`,
      ),
    );
    const byKind = group(result.proposals, (p) => p.kind);
    for (const k of Object.keys(byKind)) {
      console.log(kleur.cyan(`\n${k} (${byKind[k]?.length ?? 0})`));
      for (const p of (byKind[k] ?? []).slice(0, 20)) {
        console.log(`  • ${p.text} ${kleur.dim(`[${p.source} ${p.evidence_link ?? ""} conf=${p.confidence}]`)}`);
      }
    }

    if (opts.apply) {
      const noteCount = await appendProposals(root, result.proposals.filter((p) => p.kind === "note"), "notes");
      const decCount = await appendProposals(root, result.proposals.filter((p) => p.kind === "decision"), "decisions");
      console.log(kleur.green(`\n✓ applied ${noteCount} note(s), ${decCount} decision(s)`));
    } else {
      const out = path.join(root, ".gps", "proposals.yml");
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, stringifyYaml(result));
      console.log(kleur.dim(`\nwrote ${path.relative(root, out)} — review, then re-run with --apply`));
    }
  });
}

async function appendProposals(
  root: string,
  proposals: SeedProposal[],
  kind: "notes" | "decisions",
): Promise<number> {
  if (proposals.length === 0) return 0;
  const dir = path.join(root, ".gps", kind);
  await mkdir(dir, { recursive: true });
  // Bucket everything under a single "_seed" target so seeding is reversible.
  const file = path.join(dir, "_seed.yml");
  let existing: unknown[] = [];
  try {
    const raw = await readFile(file, "utf8");
    const data = parseYaml(raw);
    if (Array.isArray(data)) existing = data;
  } catch {
    /* new file */
  }
  const now = new Date().toISOString();
  const entries = proposals.map((p) => {
    if (kind === "notes") {
      return {
        symbol: p.symbol ?? "_seed",
        lesson: p.text,
        severity: "low",
        promoted: false,
        recorded_at: now,
        source: p.source === "pr" ? "pr" : p.source === "todo" ? "todo" : "git",
        scope: "global",
        evidence_link: p.evidence_link,
        confidence: p.confidence,
      };
    }
    return {
      symbol: p.symbol ?? "_seed",
      decision: p.text,
      recorded_at: now,
      source: p.source === "pr" ? "pr" : "seed",
      evidence_link: p.evidence_link,
      confidence: p.confidence,
    };
  });
  const next = [...existing, ...entries];
  await writeFile(file, stringifyYaml(next));
  return entries.length;
}

function group<T>(items: T[], key: (x: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const x of items) {
    const k = key(x);
    (out[k] ??= []).push(x);
  }
  return out;
}
