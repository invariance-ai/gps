import path from "node:path";
import { realpathSync } from "node:fs";
import ts from "typescript";
import type { GpsIndex } from "./index_store.js";
import { wilson, type WilsonCI } from "./stats.js";

export type { WilsonCI };

function realRel(root: string, abs: string): string {
  try {
    return path.relative(realpathSync(root), realpathSync(abs));
  } catch {
    return path.relative(root, abs);
  }
}

/**
 * tsserver resolves workspace package imports to the built dist/.d.ts file
 * (whatever `main`/`types` points at). GPS tracks source files. Normalize
 * both ends so monorepos don't all look "wrong" when they're actually right.
 *
 * Strip every JS/TS extension we might encounter (incl. .d.ts, .mjs, .cjs,
 * .jsx) so file:name comparisons match regardless of how either side wrote it.
 */
function normalizeTarget(p: string): string {
  // packages/<x>/dist/foo.d.ts → packages/<x>/src/foo
  return p
    .replace(/\/dist\//, "/src/")
    .replace(/\.(d\.)?(ts|tsx|js|jsx|mjs|cjs):/, ":");
}

/**
 * Verify GPS's symbol graph against TypeScript's own type checker.
 *
 * For each sampled call edge we recorded, ask `ts` what the call at
 * (file, line) actually resolves to. Compare GPS's `to` against the real
 * symbol's declaration file + name. Also sample call sites that ts knows
 * about but GPS may have missed (recall).
 *
 * Three numbers ship in the report:
 *   precision = confirmed / (confirmed + contradicted)   (inconclusive excluded)
 *   recall    = (ts edges GPS has) / (sampled ts edges)
 *   coverage  = (GPS edges with status ∈ {exact, typed}) / (total GPS edges)
 *
 * Python is intentionally out of scope here — pyright shell-out lives in
 * a separate verify_index_py module when we add it.
 */
export interface VerifyReport {
  language: "typescript";
  sample_size: number;
  total_edges: number;
  precision: number;
  precision_ci: WilsonCI;
  precision_confirmed: number;
  precision_contradicted: number;
  precision_inconclusive: number;
  recall: number;
  recall_ci: WilsonCI;
  recall_seen: number;
  recall_hit: number;
  coverage: number;
  worst: Array<{
    from_file: string;
    from_line: number;
    callee: string;
    gps_resolved_to?: string;
    ts_resolved_to?: string;
    issue: "wrong_target" | "ts_says_no_target" | "gps_missed";
  }>;
}

export interface VerifyOptions {
  root: string;
  sample?: number;
  /** Cap concurrent ts programs. The whole program is built once. */
  seed?: number;
}

const DEFAULT_SAMPLE = 200;

/** mulberry32 — deterministic 32-bit PRNG so seeded runs reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function resolveSeed(opt?: number): number | undefined {
  if (opt !== undefined && Number.isFinite(opt)) return Math.trunc(opt);
  const env = process.env.GPS_VERIFY_SEED;
  if (env && env.trim() !== "") {
    const n = Number(env);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return undefined;
}

export async function verifyIndex(
  index: GpsIndex,
  opts: VerifyOptions,
): Promise<VerifyReport> {
  const { root, sample = DEFAULT_SAMPLE } = opts;
  const seed = resolveSeed(opts.seed);
  const rand: () => number = seed !== undefined ? mulberry32(seed) : Math.random;

  // Build a ts Program over the TS files GPS indexed.
  const tsFiles = index.files
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js") || f.endsWith(".jsx"))
    .map((f) => path.resolve(root, f));
  if (tsFiles.length === 0) {
    return {
      language: "typescript",
      sample_size: 0,
      total_edges: index.edges.length,
      precision: 1,
      precision_ci: { low: 0, high: 1 },
      precision_confirmed: 0,
      precision_contradicted: 0,
      precision_inconclusive: 0,
      recall: 1,
      recall_ci: { low: 0, high: 1 },
      recall_seen: 0,
      recall_hit: 0,
      coverage: coverageOf(index),
      worst: [],
    };
  }

  const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json")
    ?? ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.base.json");
  let compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    noEmit: true,
    skipLibCheck: true,
  };
  if (configPath) {
    const raw = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!raw.error) {
      const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(configPath));
      compilerOptions = { ...compilerOptions, ...parsed.options };
    }
  }
  const program = ts.createProgram(tsFiles, compilerOptions);
  const checker = program.getTypeChecker();

  // Pre-compute line offsets per source file for quick lookups.
  const lineCache = new Map<string, ts.SourceFile>();
  for (const f of tsFiles) {
    const sf = program.getSourceFile(f);
    if (sf) lineCache.set(f, sf);
  }

  // --- Precision pass: sample edges from GPS, ask ts who's actually called.
  const tsEdges = index.edges.filter(
    (e) => e.file && (e.file.endsWith(".ts") || e.file.endsWith(".tsx") || e.file.endsWith(".js") || e.file.endsWith(".jsx")),
  );
  const sampleEdges = pickRandom(tsEdges, sample, rand);
  const worst: VerifyReport["worst"] = [];
  let confirmed = 0;
  let contradicted = 0;
  let inconclusive = 0;
  for (const edge of sampleEdges) {
    const absFile = path.resolve(root, edge.file!);
    const sf = lineCache.get(absFile);
    if (!sf) {
      inconclusive++;
      continue;
    }
    const callee = lastNameOf(edge.to);
    const callExpr = findCallAt(sf, edge.line ?? 1, callee);
    if (!callExpr) {
      // ts can't even find the call site — neither confirm nor contradict.
      inconclusive++;
      continue;
    }
    const sym = aliasedTarget(checker, checker.getSymbolAtLocation(callExpr.expression));
    const declFile = sym?.declarations?.[0]?.getSourceFile().fileName;
    const declName = sym?.getName();
    const tsTarget = declFile && declName ? `${realRel(root, declFile)}:${declName}` : undefined;
    const gpsTarget = `${guessTargetFile(index, edge)}:${callee}`;
    if (!tsTarget) {
      // ts found the call but couldn't resolve a target — can't judge GPS.
      inconclusive++;
      worst.push({
        from_file: edge.file!,
        from_line: edge.line ?? 0,
        callee,
        gps_resolved_to: gpsTarget,
        issue: "ts_says_no_target",
      });
      continue;
    }
    // Match by file path + name (after dist/src normalization).
    if (normalizeTarget(tsTarget) === normalizeTarget(gpsTarget)) {
      confirmed++;
    } else {
      contradicted++;
      worst.push({
        from_file: edge.file!,
        from_line: edge.line ?? 0,
        callee,
        gps_resolved_to: gpsTarget,
        ts_resolved_to: tsTarget,
        issue: "wrong_target",
      });
    }
  }

  // --- Recall pass: enumerate ALL callsites ts can find across the project,
  //     then sample from that flat list. Same shape as the GPS-edges side,
  //     which keeps per-file density bias out of the recall denominator.
  interface RecallSite {
    file: string;
    line: number;
    callee: string;
  }
  const allSites: RecallSite[] = [];
  for (const f of tsFiles) {
    const sf = lineCache.get(f);
    if (!sf) continue;
    const relFile = path.relative(root, f);
    visitCalls(sf, (callExpr, line) => {
      // Skip method calls — GPS's parser intentionally doesn't track them.
      if (ts.isPropertyAccessExpression(callExpr.expression)) return;
      const callee = nameOfCallExpression(callExpr);
      if (!callee) return;
      // Skip externals — recall should measure project edges, not lib.es5.d.ts.
      const sym = aliasedTarget(checker, checker.getSymbolAtLocation(callExpr.expression));
      const declFile = sym?.declarations?.[0]?.getSourceFile().fileName;
      if (!declFile || declFile.includes("node_modules") || declFile.includes("/lib.")) return;
      allSites.push({ file: relFile, line, callee });
    });
  }
  const recallSample = pickRandom(allSites, sample, rand);
  let recallSeen = 0;
  let recallHit = 0;
  for (const site of recallSample) {
    recallSeen++;
    const matched = index.edges.some(
      (e) => e.file === site.file && Math.abs((e.line ?? 0) - site.line) <= 1 && lastNameOf(e.to) === site.callee,
    );
    if (matched) recallHit++;
    else if (worst.length < 10) {
      worst.push({
        from_file: site.file,
        from_line: site.line,
        callee: site.callee,
        issue: "gps_missed",
      });
    }
  }

  const precisionDenom = confirmed + contradicted;
  const precision = precisionDenom === 0 ? 1 : confirmed / precisionDenom;
  const recall = recallSeen === 0 ? 1 : recallHit / recallSeen;

  return {
    language: "typescript",
    sample_size: sampleEdges.length,
    total_edges: index.edges.length,
    precision,
    precision_ci: wilson(confirmed, precisionDenom),
    precision_confirmed: confirmed,
    precision_contradicted: contradicted,
    precision_inconclusive: inconclusive,
    recall,
    recall_ci: wilson(recallHit, recallSeen),
    recall_seen: recallSeen,
    recall_hit: recallHit,
    coverage: coverageOf(index),
    worst: worst.slice(0, 10),
  };
}

function coverageOf(index: GpsIndex): number {
  if (index.edges.length === 0) return 1;
  const good = index.edges.filter(
    (e) => e.resolution_status === "exact" || e.resolution_status === "typed",
  ).length;
  return good / index.edges.length;
}

function lastNameOf(qualified: string): string {
  return qualified.split(".").pop() ?? qualified;
}

function guessTargetFile(index: GpsIndex, edge: GpsIndex["edges"][number]): string {
  // Prefer the stable id — edges record `to_id` precisely so we can identify
  // the actual resolved target without falling back to name-only lookup, which
  // would pick an arbitrary same-name symbol when collisions exist.
  if (edge.to_id) {
    const byId = index.symbols.find((s) => s.id === edge.to_id);
    if (byId) return byId.file;
  }
  const target = index.symbols.find((s) => (s.qualified_name ?? s.name) === edge.to);
  return target?.file ?? "?";
}

function pickRandom<T>(arr: T[], n: number, rand: () => number = Math.random): T[] {
  if (arr.length <= n) return arr.slice();
  const out: T[] = [];
  const used = new Set<number>();
  while (out.length < n) {
    const i = Math.floor(rand() * arr.length);
    if (used.has(i)) continue;
    used.add(i);
    out.push(arr[i]!);
  }
  return out;
}

function findCallAt(
  sf: ts.SourceFile,
  line: number,
  calleeHint: string,
): ts.CallExpression | undefined {
  let result: ts.CallExpression | undefined;
  function visit(n: ts.Node): void {
    if (result) return;
    if (ts.isCallExpression(n)) {
      const pos = sf.getLineAndCharacterOfPosition(n.getStart(sf));
      if (Math.abs(pos.line + 1 - line) <= 1) {
        const name = nameOfCallExpression(n);
        if (!calleeHint || name === calleeHint) {
          result = n;
          return;
        }
      }
    }
    n.forEachChild(visit);
  }
  visit(sf);
  return result;
}

function visitCalls(
  sf: ts.SourceFile,
  fn: (n: ts.CallExpression, line: number) => void,
): void {
  function visit(n: ts.Node): void {
    if (ts.isCallExpression(n)) {
      const pos = sf.getLineAndCharacterOfPosition(n.getStart(sf));
      fn(n, pos.line + 1);
    }
    n.forEachChild(visit);
  }
  visit(sf);
}

function aliasedTarget(checker: ts.TypeChecker, sym: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!sym) return undefined;
  let cur = sym;
  let guard = 0;
  while (cur.flags & ts.SymbolFlags.Alias && guard++ < 5) {
    try {
      cur = checker.getAliasedSymbol(cur);
    } catch {
      break;
    }
  }
  return cur;
}

function nameOfCallExpression(n: ts.CallExpression): string | undefined {
  const e = n.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}
