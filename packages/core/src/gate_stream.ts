import { mkdir, readFile } from "node:fs/promises";
import { createWriteStream, openSync, writeSync, closeSync } from "node:fs";
import type { WriteStream } from "node:fs";
import path from "node:path";
import chokidar from "chokidar";
import { changedHunks, symbolsInHunks } from "./diff_to_symbols.js";
import { gateIncremental, type GateResult } from "./gate.js";
import { loadConfig, scanFiles } from "./scan.js";

/**
 * Live gate stream: watches the working tree and appends gate findings to
 * .gps/cache/gate-stream.jsonl whenever a touched symbol violates an
 * invariant. The watch is debounced (default 500ms) so a burst of edits
 * collapses to one evaluation.
 *
 * Consumed by:
 *   - `gps gate --watch` (prints findings as they arrive)
 *   - the `gate_stream` MCP tool (tail since seq or timestamp)
 *   - agent hooks (PostToolUse → `gps gate --changed --json`)
 *
 * Concurrency note: hooks (one-shot writers) and a long-running `--watch`
 * loop may write to the same JSONL concurrently. We rely on the POSIX
 * guarantee that writes to a file opened O_APPEND that fit within PIPE_BUF
 * (≥512 bytes per POSIX, 4096 on Linux, 512 on macOS) are atomic — so two
 * processes appending small JSON lines won't tear. Each entry must stay
 * under that bound; large hit lists could exceed it. If we ever produce
 * larger entries, switch to an exclusive lockfile or chunked appends.
 */
const REL = ".gps/cache/gate-stream.jsonl";

export function gateStreamPath(root: string): string {
  return path.join(root, REL);
}

export interface GateStreamEntry {
  /** Monotonic per-file counter; preferred cursor for tailing. */
  seq: number;
  ts: string;
  changed_files: string[];
  changed_symbols: string[];
  hits: GateResult["hits"];
  blocking: GateResult["blocking"];
}

export async function readGateStream(
  root: string,
  opts: { since?: string; since_seq?: number; limit?: number } = {},
): Promise<GateStreamEntry[]> {
  let raw: string;
  try {
    raw = await readFile(gateStreamPath(root), "utf8");
  } catch {
    return [];
  }
  const entries: GateStreamEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<GateStreamEntry>;
      // backwards-compat: older entries without `seq` get 0
      if (typeof parsed.seq !== "number") parsed.seq = 0;
      entries.push(parsed as GateStreamEntry);
    } catch {
      // skip malformed
    }
  }
  let out = entries;
  if (typeof opts.since_seq === "number") {
    const cutoff = opts.since_seq;
    out = out.filter((e) => e.seq > cutoff);
  } else if (opts.since) {
    const cutoff = new Date(opts.since).getTime();
    out = out.filter((e) => new Date(e.ts).getTime() > cutoff);
  }
  if (opts.limit) out = out.slice(-opts.limit);
  return out;
}

/**
 * Read the maximum `seq` value currently persisted. Used by watchers to
 * resume numbering after a restart so cursors remain monotonic.
 */
async function readMaxSeq(root: string): Promise<number> {
  const entries = await readGateStream(root);
  let max = 0;
  for (const e of entries) if (e.seq > max) max = e.seq;
  return max;
}

/**
 * Append a single entry using a short-lived O_APPEND fd. Used by one-shot
 * callers (hooks, `gps gate --changed`) where the cost of opening a fd is
 * dwarfed by the gate evaluation itself. See concurrency note above.
 */
export async function appendGateStreamEntry(
  root: string,
  entry: Omit<GateStreamEntry, "seq"> & { seq?: number },
): Promise<GateStreamEntry> {
  const p = gateStreamPath(root);
  await mkdir(path.dirname(p), { recursive: true });
  const seq = entry.seq ?? (await readMaxSeq(root)) + 1;
  const full: GateStreamEntry = { ...entry, seq };
  const line = JSON.stringify(full) + "\n";
  // openSync/writeSync/closeSync — O_APPEND atomic for writes < PIPE_BUF.
  const fd = openSync(p, "a");
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
  return full;
}

export interface WatchOptions {
  /** Milliseconds to wait between bursts before re-evaluating. */
  debounceMs?: number;
  /** Called whenever a new gate evaluation finishes. */
  onEntry?: (entry: GateStreamEntry) => void;
  /** Base ref to diff against (default HEAD). */
  base?: string;
  /**
   * Milliseconds chokidar waits for a file to stop changing before emitting
   * an event. Tests can lower this to keep runs fast. Defaults to 300ms.
   */
  stabilityThresholdMs?: number;
  /** Extra paths to ignore (regex or glob). */
  ignored?: (RegExp | string)[];
}

export interface WatchHandle {
  /**
   * Stop watching and flush in-flight work. Awaits any evaluate() currently
   * running so callers can safely exit without truncating a JSONL entry.
   */
  stop(): Promise<void>;
}

/**
 * Watch the source tree (limited to indexed files). Returns a handle the
 * caller can use to stop watching.
 */
export async function watchGateStream(
  root: string,
  opts: WatchOptions = {},
): Promise<WatchHandle> {
  const debounceMs = opts.debounceMs ?? 500;
  const base = opts.base ?? "HEAD";
  const stabilityThreshold = opts.stabilityThresholdMs ?? 300;

  const config = await loadConfig(root);
  const files = await scanFiles(root, config);
  const watched = new Set<string>(files);

  // Long-lived O_APPEND stream — see concurrency note at top of file.
  // Reusing one stream avoids the per-entry open/close cost while keeping
  // writes atomic for entries that fit within PIPE_BUF.
  await mkdir(path.dirname(gateStreamPath(root)), { recursive: true });
  const stream: WriteStream = createWriteStream(gateStreamPath(root), {
    flags: "a",
  });

  let seqCounter = await readMaxSeq(root);

  let timer: NodeJS.Timeout | undefined;
  let pending = new Set<string>();
  // Track in-flight evaluate() so stop() can await it — prevents truncated
  // JSONL entries if SIGINT lands mid-write (PR #25 review concern).
  let inflight: Promise<void> | undefined;

  async function evaluate(): Promise<void> {
    const hunks = await changedHunks(root, base);
    if (hunks.length === 0) return;
    const symbols = await symbolsInHunks(root, hunks);
    const result = await gateIncremental(root, {
      touched_files: [...new Set(hunks.map((h) => h.file))],
      touched_symbols: symbols.map((s) => s.qualified_name),
    });
    if (result.hits.length === 0) return;
    seqCounter += 1;
    const entry: GateStreamEntry = {
      seq: seqCounter,
      ts: new Date().toISOString(),
      changed_files: result.changed_files,
      changed_symbols: result.changed_symbols,
      hits: result.hits,
      blocking: result.blocking,
    };
    stream.write(JSON.stringify(entry) + "\n");
    opts.onEntry?.(entry);
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      pending.clear();
      const run = evaluate().catch(() => {
        /* swallow; watcher continues */
      });
      inflight = run.finally(() => {
        if (inflight === run) inflight = undefined;
      });
    }, debounceMs);
  }

  // chokidar works recursively on all platforms (no more Linux warning).
  // ignoreInitial=true: we only want events for *changes*, not the initial
  // crawl. awaitWriteFinish coalesces editor save-bursts (vim/IDEs often
  // write a temp + rename) into a single event.
  const watcher = chokidar.watch(root, {
    ignored: [
      /(^|[\\/])node_modules[\\/]/,
      /(^|[\\/])\.git[\\/]/,
      /(^|[\\/])\.gps[\\/]/,
      /(^|[\\/])dist[\\/]/,
      ...(opts.ignored ?? []),
    ],
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold, pollInterval: 100 },
  });

  const onFsEvent = (filepath: string): void => {
    const abs = path.isAbsolute(filepath) ? filepath : path.join(root, filepath);
    if (!watched.has(abs)) return;
    pending.add(abs);
    schedule();
  };
  watcher.on("change", onFsEvent);
  watcher.on("add", onFsEvent);
  watcher.on("unlink", onFsEvent);

  return {
    async stop(): Promise<void> {
      if (timer) clearTimeout(timer);
      try {
        await watcher.close();
      } catch {
        // ignore
      }
      // Wait for any in-flight evaluation so its JSONL write completes
      // before we end the stream.
      if (inflight) {
        try {
          await inflight;
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });
    },
  };
}

/**
 * Snapshot the gate against current dirty diff (no watch loop). Used by
 * `gps gate --changed` and the review-diff tool.
 */
export async function gateChanged(
  root: string,
  opts: { base?: string } = {},
): Promise<GateResult> {
  const hunks = await changedHunks(root, opts.base ?? "HEAD");
  const symbols = await symbolsInHunks(root, hunks);
  return gateIncremental(root, {
    touched_files: [...new Set(hunks.map((h) => h.file))],
    touched_symbols: symbols.map((s) => s.qualified_name),
  });
}
