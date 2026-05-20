import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const REL = ".gps/waivers.yml";

export interface Waiver {
  invariant: string;
  reason: string;
  at: string;
  by?: string;
}

export async function loadWaivers(root: string): Promise<Waiver[]> {
  try {
    const raw = await readFile(path.join(root, REL), "utf8");
    const data = parseYaml(raw);
    const items = Array.isArray(data) ? data : (data?.waivers ?? []);
    return items.filter(
      (w: unknown): w is Waiver =>
        typeof w === "object" && w !== null && typeof (w as Waiver).invariant === "string",
    );
  } catch {
    return [];
  }
}

export async function appendWaiver(
  root: string,
  w: Omit<Waiver, "at"> & { at?: string },
): Promise<Waiver> {
  const existing = await loadWaivers(root);
  const entry: Waiver = { ...w, at: w.at ?? new Date().toISOString() };
  const next = [...existing, entry];
  const p = path.join(root, REL);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, stringifyYaml(next));
  return entry;
}

export function isWaived(invariantName: string, waivers: Waiver[]): boolean {
  return waivers.some((w) => w.invariant === invariantName);
}
