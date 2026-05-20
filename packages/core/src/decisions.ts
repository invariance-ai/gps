import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { Decision, type Decision as DecisionT } from "@invariance/gps-schemas";

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
