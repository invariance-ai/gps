import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { Invariant } from "@invariance/gps-schemas";

const REL = ".gps/invariants.yml";

export async function loadInvariants(root: string): Promise<Invariant[]> {
  try {
    const raw = await readFile(path.join(root, REL), "utf8");
    const data = parseYaml(raw);
    const items = Array.isArray(data) ? data : (data?.invariants ?? []);
    return items.map((i: unknown) => Invariant.parse(i));
  } catch {
    return [];
  }
}

/**
 * Append invariants to `.gps/invariants.yml`, deduping by `name` (existing
 * names win — re-runs are idempotent). Returns how many were newly added and
 * the resulting total. Writes a flat YAML array.
 */
export async function appendInvariants(
  root: string,
  toAdd: Invariant[],
): Promise<{ added: number; total: number }> {
  const existing = await loadInvariants(root);
  const names = new Set(existing.map((i) => i.name));
  const fresh = toAdd.filter((i) => !names.has(i.name));
  if (fresh.length === 0) return { added: 0, total: existing.length };
  const merged = [...existing, ...fresh];
  const file = path.join(root, REL);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stringifyYaml(merged));
  return { added: fresh.length, total: merged.length };
}

export function invariantsFor(symbol: string, all: Invariant[]): Invariant[] {
  return all.filter((inv) => inv.applies_to.some((p) => matches(symbol, p)));
}

function matches(symbol: string, pattern: string): boolean {
  if (pattern === symbol) return true;
  if (pattern.endsWith("*")) return symbol.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith("*")) return symbol.endsWith(pattern.slice(1));
  return symbol.endsWith("." + pattern) || symbol.endsWith("/" + pattern);
}
