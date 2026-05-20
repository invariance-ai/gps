import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  Assumption,
  type Assumption as AssumptionT,
  type AssumptionConfidence,
  type AssumptionSource,
} from "@invariance/gps-schemas";

const DIR = ".gps/assumptions";

function fileFor(root: string, symbol: string): string {
  const safe = symbol.replace(/[/\\:]/g, "__").replace(/\./g, "_");
  return path.join(root, DIR, `${safe}.yml`);
}

export async function loadAssumptions(root: string, symbol: string): Promise<AssumptionT[]> {
  try {
    const raw = await readFile(fileFor(root, symbol), "utf8");
    const data = parseYaml(raw);
    if (!Array.isArray(data)) return [];
    return data.map((d: unknown) => Assumption.parse(d));
  } catch {
    return [];
  }
}

export interface AssumeOpts {
  symbol: string;
  statement: string;
  confidence?: AssumptionConfidence;
  evidence?: string;
  source?: AssumptionSource;
}

export async function appendAssumption(
  root: string,
  opts: AssumeOpts,
): Promise<{ assumption: AssumptionT; file: string }> {
  const assumption: AssumptionT = Assumption.parse({
    id: randomUUID(),
    symbol: opts.symbol,
    statement: opts.statement,
    confidence: opts.confidence ?? "medium",
    verified: false,
    evidence: opts.evidence,
    source: opts.source ?? "human",
    recorded_at: new Date().toISOString(),
  });
  const file = fileFor(root, opts.symbol);
  await mkdir(path.dirname(file), { recursive: true });
  const existing = await loadAssumptions(root, opts.symbol);
  const next = [...existing, assumption];
  await writeFile(file, stringifyYaml(next));
  return { assumption, file: path.relative(root, file) };
}

export async function verifyAssumption(
  root: string,
  symbol: string,
  id: string,
  evidence?: string,
): Promise<AssumptionT | undefined> {
  const items = await loadAssumptions(root, symbol);
  const idx = items.findIndex((a) => a.id === id);
  if (idx === -1) return undefined;
  const updated: AssumptionT = {
    ...items[idx]!,
    verified: true,
    verified_at: new Date().toISOString(),
    evidence: evidence ?? items[idx]!.evidence,
  };
  items[idx] = updated;
  await writeFile(fileFor(root, symbol), stringifyYaml(items));
  return updated;
}

export async function loadAllAssumptions(root: string): Promise<AssumptionT[]> {
  try {
    const files = await readdir(path.join(root, DIR));
    const out: AssumptionT[] = [];
    for (const f of files) {
      if (!f.endsWith(".yml")) continue;
      const raw = await readFile(path.join(root, DIR, f), "utf8");
      const data = parseYaml(raw);
      if (Array.isArray(data)) {
        for (const d of data) {
          try {
            out.push(Assumption.parse(d));
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
