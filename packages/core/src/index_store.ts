import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { SymbolRef } from "@invariance/gps-schemas";
import type { ParsedFile } from "./parser.js";
import { buildResolver, type Resolver } from "./resolver.js";
import { stableSymbolId } from "./symbol_id.js";

/**
 * v0.1 storage: a single JSON file at .gps/index/symbols.json.
 *
 * Why not SQLite/Kuzu yet: design-eval recommended SQLite, but for v0.1 the
 * dataset fits in memory comfortably (< 1MB per 100k LOC after compaction),
 * and JSON keeps `npm install -g @invariance/gps` zero-native-deps. SQLite
 * lands when repos in the wild push us past ~500k LOC or we need incremental
 * persistence between watch ticks.
 */
export interface GpsIndex {
  version: 1;
  built_at: string;
  root: string;
  files: string[];
  symbols: SymbolRef[];
  edges: Array<{
    from: string;
    to: string;
    from_id?: string;
    to_id?: string;
    type: "calls";
    file?: string;
    line?: number;
    resolution_status?: "exact" | "typed" | "heuristic" | "unresolved" | "name-only";
  }>;
}

const REL = ".gps/index/symbols.json";

export function indexPath(root: string): string {
  return path.join(root, REL);
}

export async function writeIndex(root: string, index: GpsIndex): Promise<void> {
  const p = indexPath(root);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(index, null, 2));
  indexCache.delete(p);
}

const indexCache = new Map<string, { mtimeMs: number; size: number; index: GpsIndex }>();

export function clearIndexCache(): void {
  indexCache.clear();
}

export class IndexNotBuiltError extends Error {
  readonly code = "GPS_INDEX_NOT_BUILT";
  constructor(public readonly path: string) {
    super(
      `gps index not found at ${path}. Run \`gps index\` to build it (or \`gps init\` if this repo isn't set up yet).`,
    );
    this.name = "IndexNotBuiltError";
  }
}

export async function readIndex(root: string): Promise<GpsIndex> {
  const p = indexPath(root);
  let st;
  try {
    st = await stat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new IndexNotBuiltError(p);
    }
    throw err;
  }
  const cached = indexCache.get(p);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.index;
  }
  const raw = await readFile(p, "utf8");
  const index = JSON.parse(raw) as GpsIndex;
  indexCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, index });
  return index;
}

export interface StaleReport {
  built_at: string;
  /** Files in the index whose mtime is newer than built_at. */
  stale_files: string[];
  /** Files in the index that no longer exist on disk. */
  missing_files: string[];
  total_files: number;
}

/**
 * Compare each indexed file's mtime against the index's built_at. Used by
 * `gps validate` and the Stop hook to gate attribution: a stale index will
 * map a touched file to the wrong symbol set and silently pollute weights.
 */
export async function staleFiles(root: string, index: GpsIndex): Promise<StaleReport> {
  const builtAt = new Date(index.built_at).getTime();
  const stale_files: string[] = [];
  const missing_files: string[] = [];
  await Promise.all(
    index.files.map(async (rel) => {
      try {
        const s = await stat(path.join(root, rel));
        if (s.mtimeMs > builtAt) stale_files.push(rel);
      } catch {
        missing_files.push(rel);
      }
    }),
  );
  stale_files.sort();
  missing_files.sort();
  return {
    built_at: index.built_at,
    stale_files,
    missing_files,
    total_files: index.files.length,
  };
}

export async function buildIndex(root: string, parsed: ParsedFile[]): Promise<GpsIndex> {
  const symbols: SymbolRef[] = [];
  const byName = new Map<string, SymbolRef[]>();
  const byQualifiedName = new Map<string, SymbolRef>();
  const byFileAndName = new Map<string, SymbolRef[]>();
  // Map of absFile → relativized SymbolRef[] so the resolver's responses
  // can be re-keyed to the rel-file convention used in the persisted index.
  const relByAbs = new Map<string, Map<string, SymbolRef>>();

  for (const file of parsed) {
    const absFile = file.path;
    const relFile = path.relative(root, absFile);
    const fileMap = new Map<string, SymbolRef>();
    relByAbs.set(absFile, fileMap);
    for (const s of file.symbols) {
      const qualified_name = s.qualified_name ?? s.name;
      const rel: SymbolRef = {
        ...s,
        id: stableSymbolId({ file: relFile, qualifiedName: qualified_name, body: `${qualified_name}:${s.line}` }),
        qualified_name,
        file: relFile,
      };
      symbols.push(rel);
      push(byName, rel.name, rel);
      push(byFileAndName, `${rel.file}:${rel.name}`, rel);
      if (!byQualifiedName.has(qualified_name)) byQualifiedName.set(qualified_name, rel);
      fileMap.set(rel.name, rel);
      const tail = qualified_name.split(".").pop()!;
      if (!fileMap.has(tail)) fileMap.set(tail, rel);
    }
  }

  const resolver: Resolver = await buildResolver(parsed, { root });

  const edges: GpsIndex["edges"] = [];
  for (const file of parsed) {
    const absFile = file.path;
    const relFile = path.relative(root, absFile);
    for (const cs of file.call_sites) {
      if (cs.from === "<module>" || cs.from === cs.callee_name) continue;
      const from = resolveLocalSymbol(relFile, cs.from, byFileAndName, byQualifiedName, byName);
      if (!from) continue;

      // Try the resolver first (import-graph aware) for "exact".
      const resolved = resolver.resolveCall(absFile, cs.callee_name);
      let to: SymbolRef | undefined;
      let status: NonNullable<GpsIndex["edges"][number]["resolution_status"]> = "unresolved";
      if (resolved.status === "exact" && resolved.target) {
        const targetAbs = resolved.target.file;
        const targetMap = relByAbs.get(targetAbs);
        to = targetMap?.get(resolved.target.name);
        if (to) status = "exact";
      }
      // Qualified callee (e.g. "Foo.bar" from this.bar()/self.bar() handlers)
      // resolves precisely via byQualifiedName — the class+method pair is
      // unambiguous in the same file. Mark "exact", not "heuristic".
      if (!to && cs.callee_name.includes(".")) {
        const q = byQualifiedName.get(cs.callee_name);
        if (q) {
          to = q;
          status = "exact";
        }
      }
      // Fall back to heuristic name match.
      if (!to) {
        to = resolveLocalSymbol(relFile, cs.callee_name, byFileAndName, byQualifiedName, byName);
        if (to) status = "heuristic";
      }
      if (!to) continue; // skip externals/built-ins/ambiguous globals

      edges.push({
        from: from.qualified_name ?? from.name,
        to: to.qualified_name ?? to.name,
        from_id: from.id,
        to_id: to.id,
        type: "calls",
        file: relFile,
        line: cs.line,
        resolution_status: status,
      });
    }
  }

  return {
    version: 1,
    built_at: new Date().toISOString(),
    root,
    files: parsed.map((file) => path.relative(root, file.path)),
    symbols,
    edges,
  };
}

function symbolId(file: string, qualifiedName: string, line: number): string {
  return `${file}#${qualifiedName}:${line}`;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function resolveLocalSymbol(
  file: string,
  name: string,
  byFileAndName: Map<string, SymbolRef[]>,
  byQualifiedName: Map<string, SymbolRef>,
  byName: Map<string, SymbolRef[]>,
): SymbolRef | undefined {
  const fileMatches = byFileAndName.get(`${file}:${name}`);
  if (fileMatches?.length === 1) return fileMatches[0];
  const qualified = byQualifiedName.get(name);
  if (qualified) return qualified;
  const globalMatches = byName.get(name);
  if (globalMatches?.length === 1) return globalMatches[0];
  return undefined;
}
