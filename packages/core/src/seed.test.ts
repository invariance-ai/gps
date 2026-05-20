import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SeedProposal as SeedProposalSchema, SeedResult as SeedResultSchema } from "@invariance/gps-schemas";
import { seed, SEED_TIERS, SEED_TIER_DEFAULTS, type SeedTier } from "./seed.js";

const roots: string[] = [];

async function mkTmp(): Promise<string> {
  const r = await mkdtemp(path.join(os.tmpdir(), "gps-seed-"));
  roots.push(r);
  return r;
}

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop()!;
    await rm(r, { recursive: true, force: true }).catch(() => {});
  }
});

describe("seed tier defaults", () => {
  it("declares the three known tiers in a stable order", () => {
    expect(SEED_TIERS).toEqual(["safe", "medium", "aggressive"]);
  });

  it("tier→sources is monotonically widening (aggressive ⊇ medium ⊇ safe)", () => {
    const safe = new Set(SEED_TIER_DEFAULTS.safe.sources);
    const medium = new Set(SEED_TIER_DEFAULTS.medium.sources);
    const aggressive = new Set(SEED_TIER_DEFAULTS.aggressive.sources);
    for (const s of safe) expect(medium.has(s)).toBe(true);
    for (const s of medium) expect(aggressive.has(s)).toBe(true);
    expect(aggressive.size).toBeGreaterThan(safe.size);
  });

  it("tier→minConfidence drops monotonically (safe strictest, aggressive loosest)", () => {
    expect(SEED_TIER_DEFAULTS.safe.minConfidence)
      .toBeGreaterThan(SEED_TIER_DEFAULTS.medium.minConfidence);
    expect(SEED_TIER_DEFAULTS.medium.minConfidence)
      .toBeGreaterThan(SEED_TIER_DEFAULTS.aggressive.minConfidence);
  });

  it("tier source enums match SeedProposal schema", () => {
    const allowed = SeedProposalSchema.shape.source.options;
    for (const tier of SEED_TIERS) {
      for (const src of SEED_TIER_DEFAULTS[tier].sources) {
        expect(allowed).toContain(src);
      }
    }
  });
});

describe("seed() across tiers", () => {
  it("returns schema-valid results in each tier and proposals widen with tier", async () => {
    const root = await mkTmp();
    // Plant two TS files with TODOs so the source-scan branch fires
    // without needing a real git history.
    await mkdir(path.join(root, "src"), { recursive: true });
    // `extractTodos` requires the `TODO(symbol):` form.
    await writeFile(
      path.join(root, "src", "a.ts"),
      "// TODO(createRefund): handle null user\nexport function createRefund() {}\n",
    );
    await writeFile(
      path.join(root, "src", "b.ts"),
      "// FIXME(chargeCard): rate-limit edge case on stripe\nexport function chargeCard() {}\n",
    );

    const sourceSets: Record<SeedTier, Set<string>> = {
      safe: new Set(),
      medium: new Set(),
      aggressive: new Set(),
    };

    for (const tier of SEED_TIERS) {
      const cfg = SEED_TIER_DEFAULTS[tier];
      const r = await seed(root, {
        maxCommits: cfg.maxCommits,
        maxPrs: cfg.maxPrs,
        scanFiles: ["src/**/*.ts"],
      });
      // Schema-valid envelope and proposals
      expect(() => SeedResultSchema.parse(r)).not.toThrow();
      for (const p of r.proposals) {
        expect(() => SeedProposalSchema.parse(p)).not.toThrow();
        sourceSets[tier].add(p.source);
      }
      // TODO-mining fires regardless of git availability, so safe must
      // still produce at least the planted TODO proposals.
      expect(r.proposals.length).toBeGreaterThanOrEqual(2);
      expect(r.scanned.todos).toBeGreaterThanOrEqual(2);
    }

    // Source-coverage monotonicity: aggressive ⊇ medium ⊇ safe.
    // (We only assert ⊇ because a tmpdir may have no git/PR history,
    // in which case medium/aggressive degrade to the same set as safe —
    // never a smaller one.)
    for (const s of sourceSets.safe) expect(sourceSets.medium.has(s)).toBe(true);
    for (const s of sourceSets.medium) expect(sourceSets.aggressive.has(s)).toBe(true);
  });
});
