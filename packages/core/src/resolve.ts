import path from "node:path";
import type {
  AffectedInvariant,
  Decision,
  GitHistoryEntry,
  Invariant,
  Note,
  ResolveKind,
  ResolvePacketResult,
  ResolvePrContext,
  ResolveRecallHit,
  ResolveTarget,
  SymbolRef,
  TestRef,
} from "@invariance/gps-schemas";
import {
  open,
  resolveSymbol,
  symbolNotFound,
  calleesOf,
  reverseClosure,
  affectedTests,
  prepareEdit,
  type QueryContext,
} from "./query.js";
import { neighborhood } from "./neighborhood.js";
import { loadInvariants, invariantsFor } from "./invariants.js";
import { loadNotes, loadFileNotes, loadAreaNotes, rankNotes, filterExpiredNotes } from "./notes.js";
import { loadDecisions, rankDecisions, filterExpiredDecisions } from "./decisions.js";
import { recallMemory } from "./recall.js";
import { logForFile } from "./git.js";
import { fetchPr, fetchPrThread, currentPrNumber, type PrThread } from "./gh.js";
import { diffSymbols } from "./diff_symbols.js";
import { changedHunksRange, symbolsInHunks, parseUnifiedDiff, type SymbolHit } from "./diff_to_symbols.js";

const HISTORY_FILE_CAP = 20;
const RECALL_CAP = 8;
const NOTE_CAP = 15;
const DECISION_CAP = 8;
const PRIMARY_SEED_BUDGET = 4000;

export interface BuildResolveArgs {
  target: ResolveTarget;
  /** Reverse caller depth for the blast radius (default 3). */
  hops?: number;
  /** Forward dependency (callee) depth for memory harvesting (default 2). */
  depth?: number;
  /** Git log entries per affected file (default 3; 0 = skip git history). */
  history?: number;
  /** Attach an in-flight PR's review thread when the target isn't itself a PR (default true). */
  includePr?: boolean;
}

const symKey = (s: SymbolRef): string => s.id ?? s.qualified_name ?? s.name;

/**
 * Infer the kind of a raw target string without touching the index:
 *   ""               → diff   (working-tree changes)
 *   all digits       → pr
 *   sha / ref / range→ commit (hex 7-40, contains ~ or ^, "..", or HEAD)
 *   path-like        → file   (contains "/" or has a file extension)
 *   otherwise        → symbol
 * Callers can override via an explicit `--kind`/`kind` flag.
 */
export function inferResolveKind(raw: string): ResolveKind {
  const v = raw.trim();
  if (!v) return "diff";
  if (/^\d+$/.test(v)) return "pr";
  if (/^HEAD\b/.test(v) || /[~^]/.test(v) || v.includes("..") || /^[0-9a-f]{7,40}$/i.test(v)) {
    return "commit";
  }
  if (v.includes("/") || /\.[a-z0-9]+$/i.test(v)) return "file";
  return "symbol";
}

function toPrContext(t: PrThread): ResolvePrContext {
  return {
    number: t.number,
    title: t.title,
    body: t.body,
    labels: t.labels,
    reviews: t.reviews,
    comments: t.comments,
  };
}

/** Resolve diff/PR/commit symbol hits to indexed SymbolRefs, deduped. Unindexed hits degrade to a minimal ref. */
function hitsToSeeds(hits: SymbolHit[], ctx: QueryContext): SymbolRef[] {
  const seen = new Set<string>();
  const out: SymbolRef[] = [];
  for (const h of hits) {
    const resolved = resolveSymbol(h.qualified_name, ctx);
    const ref: SymbolRef =
      resolved ?? {
        name: h.qualified_name,
        qualified_name: h.qualified_name,
        file: h.file,
        line: h.line,
        kind: "function",
      };
    const key = symKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

interface SeedResolution {
  seeds: SymbolRef[];
  pr?: ResolvePrContext;
  recallQuery: string;
}

async function resolveSeeds(ctx: QueryContext, target: ResolveTarget): Promise<SeedResolution> {
  const root = ctx.root;
  switch (target.kind) {
    case "symbol": {
      const sym = resolveSymbol(target.value, ctx);
      if (!sym) throw symbolNotFound(target.value, ctx);
      return { seeds: [sym], recallQuery: sym.name };
    }
    case "file": {
      const rel = path.relative(root, path.resolve(root, target.value));
      const seeds = ctx.index.symbols.filter((s) => s.file === rel);
      return { seeds, recallQuery: path.basename(rel) };
    }
    case "diff": {
      const { symbols } = await diffSymbols(root, target.value || "HEAD");
      return { seeds: symbols, recallQuery: seedQuery(symbols) };
    }
    case "commit": {
      const hunks = await changedHunksRange(root, `${target.value}^`, target.value);
      const seeds = hitsToSeeds(await symbolsInHunks(root, hunks), ctx);
      return { seeds, recallQuery: seedQuery(seeds) };
    }
    case "pr": {
      const [thread, snap] = await Promise.all([
        fetchPrThread(target.value),
        fetchPr(target.value),
      ]);
      const hunks = snap ? parseUnifiedDiff(snap.diff) : [];
      const seeds = hitsToSeeds(await symbolsInHunks(root, hunks), ctx);
      const pr = thread ? toPrContext(thread) : undefined;
      return { seeds, pr, recallQuery: thread?.title ?? snap?.title ?? seedQuery(seeds) };
    }
  }
}

function seedQuery(seeds: SymbolRef[]): string {
  return seeds.slice(0, 6).map((s) => s.name).join(" ");
}

function dedupeNotes(notes: Note[]): Note[] {
  const seen = new Set<string>();
  const out: Note[] = [];
  for (const n of notes) {
    const key = n.id ?? `${n.symbol}\0${n.lesson}\0${n.recorded_at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/**
 * Compose existing gps primitives into one bug-resolution packet for a target.
 * The blast radius is the reverse caller closure (`reverseClosure`); the forward
 * closure (`calleesOf`/`neighborhood`) supplies dependencies and their memory.
 * Invariants are tiered by how they reach the change (direct/transitive/
 * dependency). Git/PR history is bounded so re-runs stay cheap (logForFile is
 * cached). The JSON result is complete — markdown budgeting happens at render.
 */
export async function buildResolvePacket(
  args: BuildResolveArgs,
  ctxOrRoot: QueryContext | string,
): Promise<ResolvePacketResult> {
  const ctx = typeof ctxOrRoot === "string" ? await open(ctxOrRoot) : ctxOrRoot;
  const root = ctx.root;
  const hops = args.hops ?? 3;
  const depth = args.depth ?? 2;
  const history = args.history ?? 3;
  const includePr = args.includePr ?? true;
  const target = args.target;

  const { seeds, pr: prFromTarget, recallQuery } = await resolveSeeds(ctx, target);
  const seedKeys = new Set(seeds.map(symKey));

  // --- Reverse closure (who breaks if the seeds change), unioned across seeds ---
  const affectedMap = new Map<string, SymbolRef>();
  for (const seed of seeds) {
    for (const s of reverseClosure(ctx, seed, hops)) {
      const k = symKey(s);
      if (!seedKeys.has(k)) affectedMap.set(k, s);
    }
  }
  const affected_symbols = [...affectedMap.values()];
  const affected_files = [...new Set([...seeds, ...affected_symbols].map((s) => s.file))];

  // One batched test scan over the union of affected + seed names.
  const testNames = new Set(
    [...seeds, ...affected_symbols].map((s) => s.name).filter((n) => n.length > 2),
  );
  const affected_tests: TestRef[] = await affectedTests(ctx, testNames);

  // --- Forward closure: direct callees (dependencies) + neighborhood memory ---
  const depMap = new Map<string, SymbolRef>();
  for (const seed of seeds) {
    for (const c of calleesOf(seed, ctx)) {
      const k = symKey(c);
      if (!seedKeys.has(k)) depMap.set(k, c);
    }
  }
  const dependencies = [...depMap.values()];

  const allInvariants = await loadInvariants(root);
  const invByName = new Map<string, AffectedInvariant>();
  const relationRank: Record<AffectedInvariant["relation"], number> = {
    direct: 0,
    transitive: 1,
    dependency: 2,
  };
  const considerInv = (inv: Invariant, relation: AffectedInvariant["relation"]) => {
    const existing = invByName.get(inv.name);
    if (!existing || relationRank[relation] < relationRank[existing.relation]) {
      invByName.set(inv.name, { invariant: inv, relation });
    }
  };
  for (const seed of seeds) for (const inv of invariantsFor(symKey(seed), allInvariants)) considerInv(inv, "direct");
  for (const s of affected_symbols) for (const inv of invariantsFor(symKey(s), allInvariants)) considerInv(inv, "transitive");

  // --- Notes & decisions: per-seed memory plus neighborhood (dependency) memory ---
  const notePool: Note[] = [];
  const decisionPool: Decision[] = [];
  for (const seed of seeds) {
    notePool.push(...(await loadNotes(root, seed.name)));
    notePool.push(...(await loadFileNotes(root, seed.file)));
    notePool.push(...(await loadAreaNotes(root, path.dirname(seed.file))));
    decisionPool.push(...(await loadDecisions(root, symKey(seed))));
    for (const entry of await neighborhood(ctx, seed, depth)) {
      notePool.push(...entry.notes);
      for (const inv of entry.invariants) considerInv(inv, "dependency");
    }
  }
  const notes = rankNotes(dedupeNotes(filterExpiredNotes(notePool)), NOTE_CAP);
  const decisions = rankDecisions(filterExpiredDecisions(decisionPool), DECISION_CAP);

  const invariants = [...invByName.values()].sort((a, b) => {
    const sev = sevRank(b.invariant.severity) - sevRank(a.invariant.severity);
    if (sev !== 0) return sev;
    return relationRank[a.relation] - relationRank[b.relation];
  });

  // --- Topic-matched memory the symbol-keyed lookups miss (lessons/prefs/questions) ---
  const recall: ResolveRecallHit[] = recallQuery
    ? (
        await recallMemory(root, recallQuery, {
          related: false,
          limit: RECALL_CAP,
          kinds: ["lesson", "preference", "question", "assumption", "todo"],
        })
      ).map((h) => ({ kind: h.kind, text: h.text, score: h.score }))
    : [];

  // --- Git history (bounded, cached) for the most relevant affected files ---
  const seedFiles = new Set(seeds.map((s) => s.file));
  const orderedFiles = [...affected_files].sort((a, b) => {
    const aSeed = seedFiles.has(a) ? 0 : 1;
    const bSeed = seedFiles.has(b) ? 0 : 1;
    return aSeed - bSeed;
  });
  const git_history: GitHistoryEntry[] = [];
  if (history > 0) {
    for (const file of orderedFiles.slice(0, HISTORY_FILE_CAP)) {
      const commits = await logForFile(root, file, history);
      if (commits.length) git_history.push({ file, commits });
    }
  }

  // --- PR context: from the target, or an in-flight PR riding along ---
  let pr = prFromTarget;
  if (!pr && includePr && target.kind !== "pr") {
    const num = await currentPrNumber(root);
    if (num != null) {
      const thread = await fetchPrThread(num);
      if (thread) pr = toPrContext(thread);
    }
  }

  // --- Decision-ready brief for the primary seed only ---
  let prepare_markdown: string | undefined;
  const primary = seeds[0];
  if (primary) {
    try {
      const brief = await prepareEdit(
        { symbol: symKey(primary), intent: "resolve packet", budget: PRIMARY_SEED_BUDGET },
        ctx,
      );
      prepare_markdown = brief.markdown;
    } catch {
      // primary seed may be an unindexed diff/PR hit — skip the brief.
    }
  }

  return {
    target,
    seeds,
    affected_symbols,
    affected_files,
    affected_tests,
    blast_radius: affected_symbols.length,
    dependencies,
    invariants,
    notes,
    decisions,
    recall,
    git_history,
    pr,
    prepare_markdown,
    truncated: [],
  };
}

function sevRank(sev: string): number {
  return sev === "block" ? 2 : sev === "warn" ? 1 : 0;
}
