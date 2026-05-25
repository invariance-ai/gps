import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { Decision, type Decision as DecisionT } from "@invariance/gps-schemas";

/** Returns true if a decision has expired (expires_at is in the past). */
export function isDecisionExpired(decision: DecisionT, now: Date = new Date()): boolean {
  if (!decision.expires_at) return false;
  const ms = Date.parse(decision.expires_at);
  if (Number.isNaN(ms)) return false;
  return ms < now.getTime();
}

/** Filter out expired decisions from an array. */
export function filterExpiredDecisions(decisions: DecisionT[], now: Date = new Date()): DecisionT[] {
  return decisions.filter((d) => !isDecisionExpired(d, now));
}

/**
 * Stamp `last_surfaced_at` on the given decisions (in-place) and persist back to disk.
 * Best-effort: never throws.
 */
export async function touchSurfacedDecisions(root: string, decisions: DecisionT[]): Promise<void> {
  if (decisions.length === 0) return;
  const now = new Date().toISOString();
  const bySymbol = new Map<string, DecisionT[]>();
  for (const d of decisions) {
    const arr = bySymbol.get(d.symbol) ?? [];
    arr.push(d);
    bySymbol.set(d.symbol, arr);
  }
  for (const d of decisions) {
    (d as DecisionT & { last_surfaced_at?: string }).last_surfaced_at = now;
  }
  for (const [symbol, surfaced] of bySymbol) {
    try {
      const surfacedIds = new Set(surfaced.map((d) => d.id).filter(Boolean));
      const surfacedDecisions = new Set(surfaced.map((d) => d.decision));
      const filePath = fileFor(root, symbol);
      const raw = await readFile(filePath, "utf8");
      const data = parseYaml(raw);
      if (!Array.isArray(data)) continue;
      const updated = data.map((item: unknown) => {
        try {
          const existing = Decision.parse(item);
          const match =
            (existing.id && surfacedIds.has(existing.id)) ||
            (!existing.id && surfacedDecisions.has(existing.decision));
          if (!match) return existing;
          return { ...existing, last_surfaced_at: now };
        } catch {
          return item;
        }
      });
      await writeFile(filePath, stringifyYaml(updated));
    } catch {
      /* best-effort */
    }
  }
}

const DIR = ".gps/decisions";

function fileFor(root: string, symbol: string): string {
  const safe = symbol.replace(/[/\\:]/g, "__").replace(/\./g, "_");
  return path.join(root, DIR, `${safe}.yml`);
}

export async function loadDecisions(root: string, symbol: string): Promise<DecisionT[]> {
  try {
    const raw = await readFile(fileFor(root, symbol), "utf8");
    const data = parseYaml(raw);
    if (!Array.isArray(data)) return [];
    return data.map((d: unknown) => Decision.parse(d));
  } catch {
    return [];
  }
}

export interface AppendDecisionOpts {
  symbol: string;
  decision: string;
  rejected_alternative?: string;
  rationale?: string;
  made_by?: string;
  session?: string;
}

export async function appendDecision(
  root: string,
  opts: AppendDecisionOpts,
): Promise<{ decision: DecisionT; file: string }> {
  const decision: DecisionT = Decision.parse({
    symbol: opts.symbol,
    decision: opts.decision,
    rejected_alternative: opts.rejected_alternative,
    rationale: opts.rationale,
    made_by: opts.made_by,
    session: opts.session,
    recorded_at: new Date().toISOString(),
  });
  const file = fileFor(root, opts.symbol);
  await mkdir(path.dirname(file), { recursive: true });
  const existing = await loadDecisions(root, opts.symbol);
  const next = [...existing, decision];
  await writeFile(file, stringifyYaml(next));
  return { decision, file: path.relative(root, file) };
}

export function rankDecisions(decisions: DecisionT[], limit = 3): DecisionT[] {
  // Recent first.
  return decisions
    .slice()
    .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))
    .slice(0, limit);
}

export async function loadAllDecisions(root: string): Promise<DecisionT[]> {
  try {
    const files = await readdir(path.join(root, DIR));
    const out: DecisionT[] = [];
    for (const f of files) {
      if (!f.endsWith(".yml")) continue;
      const raw = await readFile(path.join(root, DIR, f), "utf8");
      const data = parseYaml(raw);
      if (Array.isArray(data)) {
        for (const d of data) {
          try {
            out.push(Decision.parse(d));
          } catch {
            /* skip malformed */
          }
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}
