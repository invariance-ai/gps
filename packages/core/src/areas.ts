import path from "node:path";
import type { AliasBinding, FeaturesFile as FeaturesFileT } from "@invariance/gps-schemas";
import {
  loadFeatures,
  saveFeatures,
  getActive,
  normalizeLabel,
  readLastAttribution,
} from "./features.js";

/**
 * Location-anchored context. An `area` is a directory; an alias is a
 * human-friendly name ("home") that resolves to a file + its directory + an
 * optional linked feature. The alias registry lives in the `aliases` map of
 * `.gps/features.yml`.
 */

/** Alias names are normalized the same way feature labels are (kebab-case). */
export function normalizeAlias(raw: string): string {
  return normalizeLabel(raw);
}

/** POSIX dirname — index file paths always use forward slashes. */
function dirOf(file: string): string {
  const d = path.posix.dirname(file.replace(/\\/g, "/"));
  return d === "." ? "" : d;
}

export async function loadAliases(
  root: string,
): Promise<Record<string, AliasBinding>> {
  const features = await loadFeatures(root);
  return features.aliases ?? {};
}

export function resolveAlias(
  features: FeaturesFileT,
  name: string,
): AliasBinding | undefined {
  return features.aliases?.[normalizeAlias(name)];
}

export interface UpsertAliasPatch {
  file?: string;
  dir?: string;
  feature?: string;
  source?: "user" | "auto";
}

/** Create or merge an alias binding in `.gps/features.yml`. */
export async function upsertAlias(
  root: string,
  rawName: string,
  patch: UpsertAliasPatch = {},
): Promise<AliasBinding> {
  const name = normalizeAlias(rawName);
  if (!name) throw new Error("Alias name is empty after normalization");
  const features = await loadFeatures(root);
  if (!features.aliases) features.aliases = {};
  const now = new Date().toISOString();
  const existing = features.aliases[name];
  const dir = patch.dir ?? (patch.file ? dirOf(patch.file) : existing?.dir);
  const binding: AliasBinding = {
    name,
    file: patch.file ?? existing?.file,
    dir,
    feature: patch.feature ?? existing?.feature,
    source: patch.source ?? existing?.source ?? "auto",
    created_at: existing?.created_at ?? now,
    last_resolved: now,
    hits: existing?.hits ?? 0,
  };
  features.aliases[name] = binding;
  await saveFeatures(root, features);
  return binding;
}

/**
 * Auto-learn alias locations from a set of just-edited files. Mutates the
 * passed FeaturesFile in place (the caller is expected to persist it — this
 * piggy-backs on attributeFiles' existing save to avoid write contention).
 *
 * Binds an alias when (a) it is the only unbound alias and exactly one file
 * was edited, or (b) a dirty file's basename (sans extension) matches the
 * alias name. `source: "user"` bindings that already have a file are left
 * untouched.
 */
export function bindAliasLocation(
  features: FeaturesFileT,
  dirtyFiles: string[],
  activeLabel?: string,
): string[] {
  if (!features.aliases) return [];
  const bound: string[] = [];
  const now = new Date().toISOString();
  const unbound = Object.values(features.aliases).filter((a) => !a.file);
  if (unbound.length === 0 || dirtyFiles.length === 0) return bound;

  const bind = (alias: AliasBinding, file: string): void => {
    alias.file = file;
    alias.dir = dirOf(file);
    alias.last_resolved = now;
    if (activeLabel && !alias.feature) alias.feature = normalizeLabel(activeLabel);
    bound.push(alias.name);
  };

  // (b) basename fuzzy-match — strongest signal, works even with many edits.
  for (const alias of unbound) {
    if (alias.file) continue;
    for (const file of dirtyFiles) {
      const base = path.posix.basename(file).replace(/\.[^.]+$/, "");
      if (normalizeAlias(base) === alias.name) {
        bind(alias, file);
        break;
      }
    }
  }

  // (a) one unbound alias + one edited file.
  const stillUnbound = unbound.filter((a) => !a.file);
  const soleAlias = stillUnbound[0];
  const soleFile = dirtyFiles[0];
  if (stillUnbound.length === 1 && dirtyFiles.length === 1 && soleAlias && soleFile) {
    bind(soleAlias, soleFile);
  }

  return bound;
}

/**
 * Resolve the "active area" — the directory that "here"/"this" refers to.
 * Precedence: explicit hint > active feature's bound alias dir > directory of
 * the most-recently edited file. Returns undefined when nothing resolves.
 */
export async function resolveActiveArea(
  root: string,
  hint?: string,
): Promise<string | undefined> {
  const features = await loadFeatures(root);

  if (hint && hint.trim()) {
    const alias = resolveAlias(features, hint);
    if (alias?.dir) return alias.dir;
    // Treat the hint as a directory path directly.
    return hint.replace(/\\/g, "/").replace(/\/+$/, "");
  }

  const activeLabel = await getActive(root);
  if (activeLabel) {
    const normalized = normalizeLabel(activeLabel);
    const candidates = Object.values(features.aliases ?? {})
      .filter((a) => a.feature === normalized && a.dir)
      .sort((x, y) => y.last_resolved.localeCompare(x.last_resolved));
    if (candidates[0]?.dir) return candidates[0].dir;
  }

  const lastAttr = await readLastAttribution(root);
  const firstFile = lastAttr?.matched_files?.[0];
  if (firstFile) return dirOf(firstFile);

  return undefined;
}

/**
 * Find the most specific registered area (alias directory) that contains the
 * given path or glob root. Returns the deepest matching directory, or
 * undefined when no registered area covers the path.
 */
export async function areaForPath(
  root: string,
  p: string,
): Promise<string | undefined> {
  const aliases = await loadAliases(root);
  // Strip glob magic to get a concrete directory prefix.
  const clean = p
    .replace(/\\/g, "/")
    .replace(/\/?\*\*.*$/, "")
    .replace(/\/?\*.*$/, "")
    .replace(/\/+$/, "");
  let best: string | undefined;
  for (const alias of Object.values(aliases)) {
    const dir = alias.dir;
    if (!dir) continue;
    if (clean === dir || clean.startsWith(dir + "/") || dir.startsWith(clean + "/") || clean === "") {
      // The path is inside the area, or the area is inside the searched path.
      if (clean === dir || clean.startsWith(dir + "/")) {
        if (!best || dir.length > best.length) best = dir;
      } else if (!best) {
        best = dir;
      }
    }
  }
  return best;
}

/**
 * Find aliases whose name is mentioned in the prompt. Word-bounded,
 * case-insensitive. Mirrors matchFeaturesInPrompt.
 */
export function matchAliasesInPrompt(
  prompt: string,
  aliases: Record<string, AliasBinding>,
): string[] {
  if (!prompt) return [];
  const lower = prompt.toLowerCase();
  const hits: string[] = [];
  for (const [name] of Object.entries(aliases)) {
    const c = name.toLowerCase().trim();
    if (!c) continue;
    const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|[^a-z0-9-])${escaped}(?:[^a-z0-9-]|$)`, "i");
    if (re.test(lower)) hits.push(name);
  }
  return hits;
}
