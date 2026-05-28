import path from "node:path";
import { accessSync, constants, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { GpsIndex } from "./index_store.js";

/**
 * Python sibling of verify_index.ts. Same precision/recall/coverage contract,
 * same JSON shape — CI gates and report consumers don't have to branch on
 * language.
 *
 * Resolution backend: pyright-langserver over stdio (LSP). We don't take
 * pyright as an npm dep (it's a heavy pip/npm install); detect on PATH and
 * skip cleanly if absent so CI runs that lack it just record a zero-sample
 * result instead of failing.
 *
 * Per-file `pyright --outputjson` doesn't surface symbol/definition info —
 * that's diagnostic output only. The language server is the only documented
 * way to get textDocument/definition out of pyright.
 */

export interface PyWilsonCI {
  low: number;
  high: number;
}

export interface PyVerifyReport {
  language: "python";
  sample_size: number;
  total_edges: number;
  precision: number;
  precision_ci: PyWilsonCI;
  precision_confirmed: number;
  precision_contradicted: number;
  precision_inconclusive: number;
  recall: number;
  recall_ci: PyWilsonCI;
  recall_seen: number;
  recall_hit: number;
  coverage: number;
  worst: Array<{
    from_file: string;
    from_line: number;
    callee: string;
    gps_resolved_to?: string;
    pyright_resolved_to?: string;
    issue: "wrong_target" | "pyright_says_no_target" | "gps_missed";
  }>;
  /** Set when pyright wasn't available; sample_size will be 0. */
  skipped_reason?: string;
}

export interface PyVerifyOptions {
  root: string;
  sample?: number;
  seed?: number;
  /** Override pyright-langserver discovery (mostly for tests). */
  pyrightLangserver?: string;
  /** Override per-request timeout (ms). */
  requestTimeoutMs?: number;
}

const DEFAULT_SAMPLE = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

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

function wilson(hits: number, n: number): PyWilsonCI {
  if (n === 0) return { low: 0, high: 1 };
  const z = 1.96;
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    low: Math.max(0, (centre - margin) / denom),
    high: Math.min(1, (centre + margin) / denom),
  };
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

function lastNameOf(qualified: string): string {
  return qualified.split(".").pop() ?? qualified;
}

function guessTargetFile(index: GpsIndex, edge: GpsIndex["edges"][number]): string {
  if (edge.to_id) {
    const byId = index.symbols.find((s) => s.id === edge.to_id);
    if (byId) return byId.file;
  }
  const target = index.symbols.find((s) => (s.qualified_name ?? s.name) === edge.to);
  return target?.file ?? "?";
}

function coverageOf(index: GpsIndex): number {
  const pyEdges = index.edges.filter((e) => e.file?.endsWith(".py"));
  if (pyEdges.length === 0) return 1;
  const good = pyEdges.filter(
    (e) => e.resolution_status === "exact" || e.resolution_status === "typed",
  ).length;
  return good / pyEdges.length;
}

function realRel(root: string, abs: string): string {
  try {
    return path.relative(realpathSync(root), realpathSync(abs));
  } catch {
    return path.relative(root, abs);
  }
}

/** Strip .py, normalize __init__ to module-name. Match TS-side normalizeTarget shape. */
function normalizePyTarget(p: string): string {
  // foo/__init__.py:bar → foo:bar
  return p
    .replace(/\/__init__\.py:/, ":")
    .replace(/\.py:/, ":");
}

/**
 * Locate `pyright-langserver` on PATH. Returns the resolved binary path or
 * undefined. We use `command -v` / `where` rather than a hard-coded path so
 * pip user-installs (`~/Library/Python/3.12/bin`) work as long as that dir is
 * in PATH for the gps process.
 */
export function findPyrightLangserver(override?: string): string | undefined {
  if (override) return override;
  if (process.platform === "win32") {
    const r = spawnSync("where", ["pyright-langserver"], { encoding: "utf8" });
    if (r.status !== 0) return undefined;
    const found = r.stdout.split(/\r?\n/).find((l) => l.trim());
    return found?.trim();
  }

  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "pyright-langserver");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep scanning PATH.
    }
  }
  return undefined;
}

interface CallSite {
  file: string;
  line: number; // 1-based
  col: number; // 0-based column of callee name start (for LSP it's 0-based char offset)
  callee: string;
}

/**
 * Find call sites in a Python source file by regex. Honest about the
 * trade-off: this is the same heuristic level as the v0.1 indexer parser, so
 * recall is "calls the parser would have found", not "every dynamic call".
 * For verify-index that's the right denominator — we're asking "does GPS's
 * index match what a simple-but-correct static reader sees?".
 */
function findPyCallSites(source: string): Array<{ line: number; col: number; callee: string }> {
  const sites: Array<{ line: number; col: number; callee: string }> = [];
  const lines = source.split(/\r?\n/);
  // Match a function call: identifier(... — skip statements like `def`, `class`, `if`, `for`.
  const callRe = /\b([A-Za-z_][\w]*)\s*\(/g;
  const skip = new Set([
    "def",
    "class",
    "if",
    "elif",
    "while",
    "for",
    "return",
    "yield",
    "and",
    "or",
    "not",
    "in",
    "is",
    "print", // builtin; recall denominator should be project edges
    "lambda",
    "with",
    "except",
    "raise",
    "import",
    "from",
    "assert",
  ]);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Strip strings/comments crudely. Good enough for sampling.
    const stripped = line.replace(/#.*$/, "").replace(/(['"])(?:\\.|(?!\1).)*\1/g, '""');
    // Skip `def foo(...)` and `class Foo(...)` — the parenthesis here is a
    // signature/bases list, not a call site. Without this we'd inflate the
    // recall denominator with hundreds of declarations the parser already
    // emits as symbols (not call edges).
    if (/^\s*(def|class)\s+[A-Za-z_]/.test(stripped)) continue;
    let m: RegExpExecArray | null;
    callRe.lastIndex = 0;
    while ((m = callRe.exec(stripped)) !== null) {
      const name = m[1]!;
      if (skip.has(name)) continue;
      // Skip attribute calls (`obj.foo()`, `mod.Cls()`) — GPS's parser
      // intentionally doesn't track them, so they don't belong in the recall
      // denominator. Mirrors the TS sibling's PropertyAccessExpression skip.
      if (m.index > 0 && stripped[m.index - 1] === ".") continue;
      sites.push({ line: i + 1, col: m.index, callee: name });
    }
  }
  return sites;
}

/**
 * Minimal LSP client for pyright-langserver. We speak only:
 *   - initialize / initialized
 *   - textDocument/didOpen
 *   - textDocument/definition
 *   - shutdown / exit
 *
 * Message framing: Content-Length headers, LF or CRLF. Pyright sends CRLF.
 */
class PyrightClient {
  private proc: ChildProcessWithoutNullStreams;
  private buf: Buffer = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private opened = new Set<string>();
  private timeoutMs: number;

  constructor(langserverPath: string, rootUri: string, timeoutMs: number) {
    this.timeoutMs = timeoutMs;
    this.proc = spawn(langserverPath, ["--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", (d: Buffer) => this.onData(d));
    this.proc.stderr.on("data", () => { /* swallow */ });
    this.proc.on("error", () => { /* surface via pending rejections */ });
    void rootUri;
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    while (true) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headers = this.buf.slice(0, headerEnd).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(headers);
      if (!m) {
        // Malformed; drop.
        this.buf = this.buf.slice(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]!);
      const total = headerEnd + 4 + len;
      if (this.buf.length < total) return;
      const body = this.buf.slice(headerEnd + 4, total).toString("utf8");
      this.buf = this.buf.slice(total);
      try {
        const msg = JSON.parse(body) as { id?: number; result?: unknown; error?: { message: string } };
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      } catch {
        // ignore
      }
    }
  }

  private send(obj: object): void {
    const body = JSON.stringify(obj);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    this.proc.stdin.write(header + body);
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pyright LSP timeout: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async initialize(rootUri: string): Promise<void> {
    await this.request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: { definition: { linkSupport: true } },
      },
      workspaceFolders: [{ uri: rootUri, name: "gps-verify" }],
      initializationOptions: {},
    });
    this.notify("initialized", {});
  }

  async openFile(absPath: string): Promise<void> {
    if (this.opened.has(absPath)) return;
    const uri = pathToFileURL(absPath).toString();
    let text = "";
    try {
      text = await readFile(absPath, "utf8");
    } catch {
      return;
    }
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "python", version: 1, text },
    });
    this.opened.add(absPath);
  }

  async definition(
    absPath: string,
    line: number,
    character: number,
  ): Promise<Array<{ uri: string; range: { start: { line: number; character: number } } }>> {
    const uri = pathToFileURL(absPath).toString();
    const result = await this.request<unknown>("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    });
    if (!result) return [];
    // result may be Location | Location[] | LocationLink[]
    const arr = Array.isArray(result) ? result : [result];
    return arr.map((r): { uri: string; range: { start: { line: number; character: number } } } => {
      const rr = r as { uri?: string; targetUri?: string; range?: { start: { line: number; character: number } }; targetRange?: { start: { line: number; character: number } } };
      return {
        uri: (rr.uri ?? rr.targetUri)!,
        range: (rr.range ?? rr.targetRange)!,
      };
    }).filter((x) => x.uri && x.range);
  }

  async shutdown(): Promise<void> {
    try {
      await this.request("shutdown", null);
    } catch { /* ignore */ }
    this.notify("exit", null);
    // Give it a tick to close, then kill.
    setTimeout(() => {
      try {
        this.proc.kill();
      } catch { /* ignore */ }
    }, 200);
  }
}

async function readSymbolNameAtDefinition(absFile: string, line: number): Promise<string | undefined> {
  try {
    const src = await readFile(absFile, "utf8");
    const lines = src.split(/\r?\n/);
    const l = lines[line];
    if (!l) return undefined;
    const m = /(?:def|class)\s+([A-Za-z_][\w]*)/.exec(l);
    return m?.[1];
  } catch {
    return undefined;
  }
}

export async function verifyIndexPython(
  index: GpsIndex,
  opts: PyVerifyOptions,
): Promise<PyVerifyReport> {
  const { root, sample = DEFAULT_SAMPLE } = opts;
  const seed = resolveSeed(opts.seed);
  const rand: () => number = seed !== undefined ? mulberry32(seed) : Math.random;

  const langserver = findPyrightLangserver(opts.pyrightLangserver);
  if (!langserver) {
    return {
      language: "python",
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
      skipped_reason:
        "pyright-langserver not found on PATH. Install with `pip install pyright` or `npm i -g pyright` and re-run.",
    };
  }

  const pyFiles = index.files
    .filter((f) => f.endsWith(".py"))
    .map((f) => path.resolve(root, f));
  if (pyFiles.length === 0) {
    return {
      language: "python",
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

  const rootUri = pathToFileURL(root).toString();
  const client = new PyrightClient(langserver, rootUri, opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  await client.initialize(rootUri);

  try {
    // ---- Precision: sample GPS's python edges, ask pyright who's actually called.
    const pyEdges = index.edges.filter((e) => e.file?.endsWith(".py"));
    const sampleEdges = pickRandom(pyEdges, sample, rand);
    const worst: PyVerifyReport["worst"] = [];
    let confirmed = 0;
    let contradicted = 0;
    let inconclusive = 0;

    for (const edge of sampleEdges) {
      const absFile = path.resolve(root, edge.file!);
      const callee = lastNameOf(edge.to);
      let src: string;
      try {
        src = await readFile(absFile, "utf8");
      } catch {
        inconclusive++;
        continue;
      }
      // Find the call at ±1 line tolerance matching the callee name.
      const lines = src.split(/\r?\n/);
      let foundLine = -1;
      let foundCol = -1;
      const targetLine = edge.line ?? 1;
      for (let dl = 0; dl <= 1 && foundLine < 0; dl++) {
        for (const candidate of [targetLine, targetLine - dl, targetLine + dl]) {
          const idx = candidate - 1;
          if (idx < 0 || idx >= lines.length) continue;
          const line = lines[idx]!;
          // Find `callee(` allowing prefix like `mod.`
          const re = new RegExp(`(?:^|[^\\w.])${callee.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\(`);
          const m = re.exec(line);
          if (m) {
            foundLine = idx; // 0-based
            // column of the callee start (right after the boundary char or 0)
            foundCol = m.index + (m[0]!.startsWith(callee) ? 0 : 1);
            break;
          }
        }
      }
      if (foundLine < 0) {
        inconclusive++;
        continue;
      }
      await client.openFile(absFile);
      let defs: Array<{ uri: string; range: { start: { line: number; character: number } } }> = [];
      try {
        defs = await client.definition(absFile, foundLine, foundCol);
      } catch {
        inconclusive++;
        continue;
      }
      if (defs.length === 0) {
        inconclusive++;
        worst.push({
          from_file: edge.file!,
          from_line: edge.line ?? 0,
          callee,
          gps_resolved_to: `${guessTargetFile(index, edge)}:${callee}`,
          issue: "pyright_says_no_target",
        });
        continue;
      }
      const def = defs[0]!;
      const defAbs = fileURLToPath(def.uri);
      const defName = (await readSymbolNameAtDefinition(defAbs, def.range.start.line)) ?? callee;
      // Skip externals (stdlib, site-packages) — those aren't GPS's job.
      if (defAbs.includes("/site-packages/") || defAbs.includes("/typeshed/") || !defAbs.startsWith(realpathSync(root))) {
        inconclusive++;
        continue;
      }
      const pyrightTarget = `${realRel(root, defAbs)}:${defName}`;
      const gpsTarget = `${guessTargetFile(index, edge)}:${callee}`;
      if (normalizePyTarget(pyrightTarget) === normalizePyTarget(gpsTarget)) {
        confirmed++;
      } else {
        contradicted++;
        worst.push({
          from_file: edge.file!,
          from_line: edge.line ?? 0,
          callee,
          gps_resolved_to: gpsTarget,
          pyright_resolved_to: pyrightTarget,
          issue: "wrong_target",
        });
      }
    }

    // ---- Recall: enumerate static call sites across the project, sample,
    //      see which GPS recorded. We don't ask pyright for every callsite —
    //      that would be O(callsites) LSP roundtrips which is unaffordable for
    //      django (~50k LOC). Instead we use the same parser-level callsite
    //      finder GPS itself targets, then check pyright on the sample to
    //      filter out unresolvables. This mirrors the TS recall denominator.
    interface RecallSite {
      file: string;
      line: number;
      col: number;
      callee: string;
    }
    const allSites: RecallSite[] = [];
    // Cap recall enumeration; large repos otherwise eat minutes just listing.
    const enumCap = 5000;
    for (const f of pyFiles) {
      if (allSites.length >= enumCap) break;
      let src: string;
      try {
        src = await readFile(f, "utf8");
      } catch {
        continue;
      }
      const relFile = path.relative(root, f);
      for (const s of findPyCallSites(src)) {
        allSites.push({ file: relFile, line: s.line, col: s.col, callee: s.callee });
        if (allSites.length >= enumCap) break;
      }
    }
    const recallSample = pickRandom(allSites, sample, rand);
    let recallSeen = 0;
    let recallHit = 0;
    for (const site of recallSample) {
      // Filter out sites pyright says are externals/unresolvable — keep the
      // denominator honest (project edges only).
      const absFile = path.resolve(root, site.file);
      await client.openFile(absFile);
      let defs: Array<{ uri: string; range: { start: { line: number; character: number } } }> = [];
      try {
        defs = await client.definition(absFile, site.line - 1, site.col);
      } catch {
        continue;
      }
      if (defs.length === 0) continue;
      const defAbs = fileURLToPath(defs[0]!.uri);
      if (defAbs.includes("/site-packages/") || defAbs.includes("/typeshed/")) continue;
      try {
        if (!defAbs.startsWith(realpathSync(root))) continue;
      } catch {
        continue;
      }
      recallSeen++;
      const matched = index.edges.some(
        (e) => e.file === site.file && Math.abs((e.line ?? 0) - site.line) <= 1 && lastNameOf(e.to) === site.callee,
      );
      if (matched) recallHit++;
      else if (worst.length < 40) {
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
      language: "python",
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
  } finally {
    await client.shutdown();
  }
}
