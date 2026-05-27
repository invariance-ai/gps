import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Passive observer — opt-in, metadata only.
 *
 * Records *which symbol was queried* and *when*, nothing else. No tool
 * arguments beyond symbol name, no tool results, no conversation content.
 * This is the privacy line: we never persist what an agent asked or what
 * we returned, only that symbol X was looked at N times.
 *
 * Feeds `gps suggest` — symbols with high query counts and no covering
 * invariant become an authoring queue.
 *
 * Storage: .gps/observations.json keyed by symbol name (qualified preferred).
 */
const REL = ".gps/observations.json";

export interface FailureEntry {
  at: string; // ISO timestamp
  kind: string; // "test" | "typecheck" | "lint" | "bash" | "other"
  message?: string;
}

export interface SymbolObservation {
  count: number;
  last_queried: string;
  tools: Record<string, number>; // count by tool name
  failures?: FailureEntry[];
  last_prepared?: string; // ISO; set by prepare flow, used by record-failure auto-pick
}

export interface ObservationStore {
  version: 1;
  symbols: Record<string, SymbolObservation>;
  last_prepared_symbol?: string;
}

function emptyStore(): ObservationStore {
  return { version: 1, symbols: {} };
}

export function observationsPath(root: string): string {
  return path.join(root, REL);
}

async function readStore(root: string): Promise<ObservationStore> {
  try {
    const raw = await readFile(observationsPath(root), "utf8");
    const data = JSON.parse(raw) as ObservationStore;
    if (data?.version === 1 && data.symbols) return data;
    return emptyStore();
  } catch {
    return emptyStore();
  }
}

async function writeStore(root: string, store: ObservationStore): Promise<void> {
  const p = observationsPath(root);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(store, null, 2));
}

export async function recordObservation(
  root: string,
  tool: string,
  symbol: string | undefined,
): Promise<void> {
  if (!symbol) return; // observer is only useful for symbol-scoped calls
  const store = await readStore(root);
  const now = new Date().toISOString();
  const entry = store.symbols[symbol] ?? {
    count: 0,
    last_queried: new Date(0).toISOString(),
    tools: {},
  };
  entry.count++;
  entry.last_queried = now;
  entry.tools[tool] = (entry.tools[tool] ?? 0) + 1;
  store.symbols[symbol] = entry;
  await writeStore(root, store);
  await appendSessionEvent(root, { type: "query", ts: now, symbol, tool });
}

/**
 * Append a session event if `.gps/session/id` exists; no-op otherwise. We
 * keep this here (and in features.ts) instead of cross-importing because both
 * modules need to write to the session log without depending on each other.
 */
async function appendSessionEvent(
  root: string,
  event: Record<string, unknown>,
): Promise<void> {
  let id: string;
  try {
    id = (await readFile(path.join(root, ".gps/session/id"), "utf8")).trim();
  } catch {
    return;
  }
  if (!id) return;
  const dir = path.join(root, ".gps/sessions");
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, `${id}.jsonl`), `${JSON.stringify(event)}\n`);
  } catch {
    /* best-effort */
  }
}

export async function readObservations(root: string): Promise<ObservationStore> {
  return readStore(root);
}

export async function recordPrepared(root: string, symbol: string): Promise<void> {
  const store = await readStore(root);
  const now = new Date().toISOString();
  const entry = store.symbols[symbol] ?? {
    count: 0,
    last_queried: new Date(0).toISOString(),
    tools: {},
  };
  entry.count++;
  entry.last_queried = now;
  entry.tools.prepare_edit = (entry.tools.prepare_edit ?? 0) + 1;
  entry.last_prepared = now;
  store.symbols[symbol] = entry;
  store.last_prepared_symbol = symbol;
  await writeStore(root, store);
  await appendSessionEvent(root, { type: "prepare", ts: now, symbol });
}

export async function recordFailure(
  root: string,
  symbol: string | undefined,
  failure: FailureEntry,
): Promise<string | null> {
  const store = await readStore(root);
  const target = symbol ?? store.last_prepared_symbol;
  if (!target) return null;
  const entry = store.symbols[target] ?? {
    count: 0,
    last_queried: new Date(0).toISOString(),
    tools: {},
  };
  entry.failures = entry.failures ?? [];
  entry.failures.push(failure);
  if (entry.failures.length > 50) entry.failures = entry.failures.slice(-50);
  store.symbols[target] = entry;
  await writeStore(root, store);

  // Side-effect: drop a TODO into .gps/todos.json so future get_context surfaces
  // unfinished work. Never edits user source files.
  const { addTodo } = await import("./todos.js");
  const text = failure.message
    ? `${failure.kind}: ${failure.message.slice(0, 160)}`
    : `${failure.kind} failure`;
  await addTodo(root, {
    file: target,
    symbol: target,
    text,
    source: "failure",
  }).catch(() => {
    /* best-effort */
  });
  return target;
}

export interface Suggestion {
  symbol: string;
  count: number;
  last_queried: string;
  failure_count: number;
  reason: "failure" | "no_invariant" | "no_note" | "high_traffic";
}

import { loadInvariants, invariantsFor } from "./invariants.js";
import { loadNotes } from "./notes.js";

/**
 * Authoring queue: symbols agents touch a lot, with no invariant covering them.
 * Heuristic threshold; tune via opts.
 */
export async function suggest(
  root: string,
  opts: { min_count?: number; limit?: number } = {},
): Promise<Suggestion[]> {
  const min = opts.min_count ?? 3;
  const limit = opts.limit ?? 10;
  const store = await readStore(root);
  const invariants = await loadInvariants(root);

  const out: Suggestion[] = [];
  for (const [symbol, entry] of Object.entries(store.symbols)) {
    const failureCount = entry.failures?.length ?? 0;
    if (entry.count < min && failureCount === 0) continue;
    const covered = invariantsFor(symbol, invariants).length > 0;
    if (covered) continue;
    const noteCount = (await loadNotes(root, symbol)).length;
    const reason: Suggestion["reason"] =
      failureCount > 0 ? "failure" : noteCount === 0 ? "no_note" : "no_invariant";
    out.push({
      symbol,
      count: entry.count,
      last_queried: entry.last_queried,
      failure_count: failureCount,
      reason,
    });
  }
  // Failures rank above pure-query symbols. Within each tier, more is worse.
  return out
    .sort((a, b) => {
      const fa = a.failure_count > 0 ? 1 : 0;
      const fb = b.failure_count > 0 ? 1 : 0;
      if (fa !== fb) return fb - fa;
      if (a.failure_count !== b.failure_count) return b.failure_count - a.failure_count;
      return b.count - a.count;
    })
    .slice(0, limit);
}
