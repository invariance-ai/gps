import { appendFile, readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  FeaturesFile,
  type Feature,
  type FeatureSymbol,
  type FeaturesFile as FeaturesFileT,
} from "@invariance/gps-schemas";
import { readIndex, type GpsIndex } from "./index_store.js";
import { bindAliasLocation } from "./areas.js";

const FEATURES_REL = ".gps/features.yml";
const ACTIVE_REL = ".gps/session/active-feature";

export function featuresPath(root: string): string {
  return path.join(root, FEATURES_REL);
}
export function activeFeaturePath(root: string): string {
  return path.join(root, ACTIVE_REL);
}

export async function loadFeatures(root: string): Promise<FeaturesFileT> {
  try {
    const raw = await readFile(featuresPath(root), "utf8");
    const data = parseYaml(raw);
    return FeaturesFile.parse(data);
  } catch {
    return { version: 1, features: {}, aliases: {} };
  }
}

export async function saveFeatures(root: string, file: FeaturesFileT): Promise<void> {
  const p = featuresPath(root);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, stringifyYaml(file));
}

export async function getActive(root: string): Promise<string | undefined> {
  try {
    const txt = (await readFile(activeFeaturePath(root), "utf8")).trim();
    return txt.length > 0 ? txt : undefined;
  } catch {
    return undefined;
  }
}

export async function clearActive(root: string): Promise<void> {
  try {
    await unlink(activeFeaturePath(root));
  } catch {
    /* not present */
  }
}

/**
 * Normalize a label to kebab-case-ish. Keep it conservative so agent-supplied
 * labels round-trip predictably.
 */
export function normalizeLabel(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export interface SetActiveResult {
  label: string;
  created: boolean;
}

async function ensureSessionDir(root: string): Promise<void> {
  const sessionDir = path.dirname(activeFeaturePath(root));
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, ".gitignore"), "*\n");
}

export async function setActive(root: string, rawLabel: string): Promise<SetActiveResult> {
  const label = normalizeLabel(rawLabel);
  if (!label) throw new Error("Feature label is empty after normalization");
  const features = await loadFeatures(root);
  const now = new Date().toISOString();
  let entry = features.features[label];
  if (!entry) {
    entry = {
      label,
      aliases: [],
      symbols: [],
      sessions: 0,
      created_at: now,
      last_active: now,
    };
    features.features[label] = entry;
  }
  const existed = entry.sessions > 0;
  entry.sessions += 1;
  entry.last_active = now;
  await saveFeatures(root, features);
  await ensureSessionDir(root);
  await writeFile(activeFeaturePath(root), label);
  return { label, created: !existed };
}

export interface SwitchActiveResult {
  label: string;
  created: boolean;
  flushed_from?: string;
  flushed_attribution?: AttributeResult;
}

/**
 * Mid-session feature swap. Flushes pending dirty-file attribution to the
 * previous active feature, then swaps without incrementing `sessions` on the
 * destination (we're not starting a new session, just re-aiming).
 */
export async function switchActive(
  root: string,
  rawLabel: string,
  dirtyFiles: string[],
): Promise<SwitchActiveResult> {
  const label = normalizeLabel(rawLabel);
  if (!label) throw new Error("Feature label is empty after normalization");

  const prev = await getActive(root);
  let flushed_attribution: AttributeResult | undefined;
  if (prev && dirtyFiles.length > 0) {
    const result = await attributeFiles(root, dirtyFiles, "edit", prev);
    if (result) flushed_attribution = result;
  }

  const features = await loadFeatures(root);
  const now = new Date().toISOString();
  let entry = features.features[label];
  const created = !entry;
  if (!entry) {
    entry = {
      label,
      aliases: [],
      symbols: [],
      sessions: 0,
      created_at: now,
      last_active: now,
    };
    features.features[label] = entry;
  }
  entry.last_active = now;
  await saveFeatures(root, features);
  await ensureSessionDir(root);
  await writeFile(activeFeaturePath(root), label);
  return {
    label,
    created,
    flushed_from: prev,
    flushed_attribution,
  };
}

/** Action signal magnitudes for the EWMA update. */
const SIGNAL = { edit: 1.0, read: 0.3 } as const;
const ALPHA = 0.3;

/** EWMA update: new = α·signal + (1-α)·prior, clamped to [0,1]. */
function ewma(prior: number, signal: number): number {
  const next = ALPHA * signal + (1 - ALPHA) * prior;
  return Math.max(0, Math.min(1, next));
}

export interface AttributeDetail {
  id: string;
  file: string;
  confidence: number;
  weight: number;
}

export interface AttributeResult {
  label: string;
  touched_symbols: number;
  matched_files: string[];
  unmatched_files: string[];
  details: AttributeDetail[];
  recorded_at: string;
}

const LAST_ATTRIBUTION_REL = ".gps/session/last-attribution.json";
const FEATURES_HISTORY_REL = ".gps/features-history.jsonl";
const HISTORY_TOP_N = 20;

export function lastAttributionPath(root: string): string {
  return path.join(root, LAST_ATTRIBUTION_REL);
}
export function featuresHistoryPath(root: string): string {
  return path.join(root, FEATURES_HISTORY_REL);
}

/**
 * Bump the active (or given) feature's symbol weights for the listed files.
 * Files are matched against the existing symbol graph; symbols whose file
 * matches receive the action signal. Files not present in the index are
 * returned in unmatched_files (callers can warn).
 */
export async function attributeFiles(
  root: string,
  files: string[],
  action: "edit" | "read",
  label?: string,
): Promise<AttributeResult | undefined> {
  const target = label ?? (await getActive(root));
  if (!target) return undefined;
  const normalized = normalizeLabel(target);
  const features = await loadFeatures(root);
  if (!features.features[normalized]) {
    features.features[normalized] = {
      label: normalized,
      aliases: [],
      symbols: [],
      sessions: 1,
      created_at: new Date().toISOString(),
      last_active: new Date().toISOString(),
    };
  }
  const feature = features.features[normalized];

  let index: GpsIndex;
  try {
    index = await readIndex(root);
  } catch {
    return {
      label: normalized,
      touched_symbols: 0,
      matched_files: [],
      unmatched_files: files,
      details: [],
      recorded_at: new Date().toISOString(),
    };
  }

  const byFile = new Map<string, typeof index.symbols>();
  for (const s of index.symbols) {
    const list = byFile.get(s.file);
    if (list) list.push(s);
    else byFile.set(s.file, [s]);
  }

  const now = new Date().toISOString();
  const bySymbolId = new Map<string, FeatureSymbol>();
  for (const sym of feature.symbols) bySymbolId.set(sym.id, sym);

  const matched: string[] = [];
  const unmatched: string[] = [];
  const details: AttributeDetail[] = [];
  let touched = 0;
  const signal = SIGNAL[action];

  for (const file of files) {
    const symbols = byFile.get(file);
    if (!symbols || symbols.length === 0) {
      unmatched.push(file);
      continue;
    }
    matched.push(file);
    const confidence = 1 / symbols.length;
    for (const s of symbols) {
      if (!s.id) continue;
      const prior = bySymbolId.get(s.id);
      const next: FeatureSymbol = {
        id: s.id,
        weight: ewma(prior?.weight ?? 0, signal),
        edits: (prior?.edits ?? 0) + (action === "edit" ? 1 : 0),
        reads: (prior?.reads ?? 0) + (action === "read" ? 1 : 0),
        last_touched: now,
        last_confidence: confidence,
      };
      bySymbolId.set(s.id, next);
      details.push({ id: s.id, file, confidence, weight: next.weight });
      touched += 1;
    }
  }

  feature.symbols = Array.from(bySymbolId.values()).sort((a, b) => b.weight - a.weight);
  feature.last_active = now;
  // Auto-learn alias locations from the edited files, piggy-backing on this
  // save so we never do a second read-modify-write of features.yml.
  bindAliasLocation(features, files, normalized);
  await saveFeatures(root, features);

  const result: AttributeResult = {
    label: normalized,
    touched_symbols: touched,
    matched_files: matched,
    unmatched_files: unmatched,
    details,
    recorded_at: now,
  };

  await ensureSessionDir(root);
  await writeFile(lastAttributionPath(root), JSON.stringify(result, null, 2));

  // Append a top-N snapshot for drift detection.
  const top = feature.symbols.slice(0, HISTORY_TOP_N).map((s) => ({
    id: s.id,
    weight: s.weight,
  }));
  await appendFile(
    featuresHistoryPath(root),
    `${JSON.stringify({ ts: now, label: normalized, action, top })}\n`,
  );

  await appendSessionEventIfActive(root, {
    type: "attribution",
    ts: now,
    label: normalized,
    touched_symbols: touched,
    matched_files: matched.length,
    low_confidence: details.filter((d) => d.confidence < 0.3).length,
  });

  return result;
}

export async function readLastAttribution(
  root: string,
): Promise<AttributeResult | undefined> {
  try {
    const raw = await readFile(lastAttributionPath(root), "utf8");
    return JSON.parse(raw) as AttributeResult;
  } catch {
    return undefined;
  }
}

export interface GcCandidate {
  id: string;
  weight: number;
}
export interface GcResult {
  label: string;
  threshold: number;
  dry_run: boolean;
  pruned: GcCandidate[];
  remaining: number;
}

export async function gcFeature(
  root: string,
  label: string,
  opts: { threshold?: number; dryRun?: boolean } = {},
): Promise<GcResult | undefined> {
  const threshold = opts.threshold ?? 0.05;
  const dryRun = opts.dryRun ?? false;
  const normalized = normalizeLabel(label);
  const features = await loadFeatures(root);
  const feature = features.features[normalized];
  if (!feature) return undefined;
  const pruned: GcCandidate[] = [];
  const remaining: FeatureSymbol[] = [];
  for (const s of feature.symbols) {
    if (s.weight < threshold) pruned.push({ id: s.id, weight: s.weight });
    else remaining.push(s);
  }
  if (!dryRun && pruned.length > 0) {
    feature.symbols = remaining;
    await saveFeatures(root, features);
  }
  return {
    label: normalized,
    threshold,
    dry_run: dryRun,
    pruned,
    remaining: remaining.length,
  };
}

export interface FeatureDiffEntry {
  id: string;
  weight_then?: number;
  weight_now?: number;
  change: "entered" | "left" | "weight";
}

export interface FeatureDiffResult {
  label: string;
  since: string;
  baseline_ts?: string;
  entries: FeatureDiffEntry[];
}

/**
 * Reads .gps/features-history.jsonl, finds the first snapshot of `label` at-or-after
 * `sinceISO`, and diffs its top-N against the current top-N. If no snapshot is
 * found, the baseline is empty and every current symbol counts as "entered".
 */
export async function featureDiff(
  root: string,
  label: string,
  sinceISO: string,
): Promise<FeatureDiffResult | undefined> {
  const normalized = normalizeLabel(label);
  const features = await loadFeatures(root);
  const feature = features.features[normalized];
  if (!feature) return undefined;

  // Baseline = latest snapshot at-or-before sinceISO (state "as of" that date).
  // If none, baseline is empty and every current symbol counts as "entered".
  let baseline: Array<{ id: string; weight: number }> = [];
  let baseline_ts: string | undefined;
  try {
    const raw = await readFile(featuresHistoryPath(root), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const snap = JSON.parse(line) as {
          ts: string;
          label: string;
          top: Array<{ id: string; weight: number }>;
        };
        if (snap.label !== normalized) continue;
        if (snap.ts <= sinceISO) {
          baseline = snap.top;
          baseline_ts = snap.ts;
        }
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* no history yet */
  }

  const thenById = new Map(baseline.map((s) => [s.id, s.weight]));
  const nowById = new Map(
    feature.symbols.slice(0, HISTORY_TOP_N).map((s) => [s.id, s.weight]),
  );

  const entries: FeatureDiffEntry[] = [];
  for (const [id, weight_now] of nowById) {
    const weight_then = thenById.get(id);
    if (weight_then === undefined) {
      entries.push({ id, weight_now, change: "entered" });
    } else if (Math.abs(weight_now - weight_then) > 0.05) {
      entries.push({ id, weight_then, weight_now, change: "weight" });
    }
  }
  for (const [id, weight_then] of thenById) {
    if (!nowById.has(id)) entries.push({ id, weight_then, change: "left" });
  }

  return { label: normalized, since: sinceISO, baseline_ts, entries };
}

/**
 * Append a session event if a `.gps/session/id` file exists. No-op otherwise.
 * Kept here to colocate with attributeFiles; observer.ts has its own variant.
 */
export async function appendSessionEventIfActive(
  root: string,
  event: Record<string, unknown>,
): Promise<void> {
  let id: string | undefined;
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

export interface OverlapEntry {
  id: string;
  weight_a: number;
  weight_b: number;
  min: number;
  product: number;
}

export async function overlapFeatures(
  root: string,
  labelA: string,
  labelB: string,
  threshold = 0.2,
): Promise<OverlapEntry[]> {
  const a = normalizeLabel(labelA);
  const b = normalizeLabel(labelB);
  const features = await loadFeatures(root);
  const fa = features.features[a];
  const fb = features.features[b];
  if (!fa || !fb) return [];
  const byId = new Map(fa.symbols.map((s) => [s.id, s.weight] as const));
  const out: OverlapEntry[] = [];
  for (const sb of fb.symbols) {
    const wa = byId.get(sb.id);
    if (wa === undefined) continue;
    const min = Math.min(wa, sb.weight);
    if (min < threshold) continue;
    out.push({ id: sb.id, weight_a: wa, weight_b: sb.weight, min, product: wa * sb.weight });
  }
  out.sort((x, y) => y.product - x.product);
  return out;
}

export interface IsolateEntry {
  id: string;
  weight: number;
}

export async function isolateFeature(
  root: string,
  label: string,
  exclusiveThreshold = 0.1,
): Promise<IsolateEntry[]> {
  const normalized = normalizeLabel(label);
  const features = await loadFeatures(root);
  const f = features.features[normalized];
  if (!f) return [];
  const others: Array<[string, number]> = [];
  for (const [lbl, other] of Object.entries(features.features)) {
    if (lbl === normalized) continue;
    for (const s of other.symbols) {
      if (s.weight >= exclusiveThreshold) others.push([s.id, s.weight]);
    }
  }
  const otherIds = new Set(others.map(([id]) => id));
  return f.symbols
    .filter((s) => !otherIds.has(s.id))
    .map((s) => ({ id: s.id, weight: s.weight }))
    .sort((a, b) => b.weight - a.weight);
}

export interface TopSymbol {
  id: string;
  weight: number;
  edits: number;
  reads: number;
  last_touched: string;
}

export async function topSymbols(
  root: string,
  label: string,
  k = 10,
): Promise<TopSymbol[]> {
  const features = await loadFeatures(root);
  const feature = features.features[normalizeLabel(label)];
  if (!feature) return [];
  return feature.symbols.slice(0, k);
}

/**
 * Find features whose label or alias is mentioned in the prompt. Word-bounded,
 * case-insensitive. Used by context-from-prompt to surface learned features.
 */
export function matchFeaturesInPrompt(
  prompt: string,
  features: Record<string, Feature>,
): string[] {
  if (!prompt) return [];
  const lower = prompt.toLowerCase();
  const hits: string[] = [];
  for (const [label, feature] of Object.entries(features)) {
    const candidates = [label, ...(feature.aliases ?? [])];
    for (const cand of candidates) {
      const c = cand.toLowerCase().trim();
      if (!c) continue;
      // Word-bounded match. Allow hyphens to act as word chars.
      const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?:^|[^a-z0-9-])${escaped}(?:[^a-z0-9-]|$)`, "i");
      if (re.test(lower)) {
        hits.push(label);
        break;
      }
    }
  }
  return hits;
}

export async function renameFeature(
  root: string,
  oldLabel: string,
  newLabel: string,
): Promise<boolean> {
  const from = normalizeLabel(oldLabel);
  const to = normalizeLabel(newLabel);
  if (!from || !to || from === to) return false;
  const features = await loadFeatures(root);
  const src = features.features[from];
  if (!src) return false;
  if (features.features[to]) {
    // Destination exists — fall through to merge semantics.
    mergeInto(features, from, to);
    await saveFeatures(root, features);
    const activeNow = await getActive(root);
    if (activeNow && normalizeLabel(activeNow) === from) {
      await writeFile(activeFeaturePath(root), to);
    }
    return true;
  }
  src.label = to;
  features.features[to] = src;
  delete features.features[from];
  await saveFeatures(root, features);
  const active = await getActive(root);
  if (active && normalizeLabel(active) === from) {
    await writeFile(activeFeaturePath(root), to);
  }
  return true;
}

export async function mergeFeatures(
  root: string,
  fromLabel: string,
  intoLabel: string,
): Promise<boolean> {
  const from = normalizeLabel(fromLabel);
  const into = normalizeLabel(intoLabel);
  if (!from || !into || from === into) return false;
  const features = await loadFeatures(root);
  if (!features.features[from] || !features.features[into]) return false;
  mergeInto(features, from, into);
  await saveFeatures(root, features);
  return true;
}

function mergeInto(file: FeaturesFileT, from: string, into: string): void {
  const src = file.features[from];
  const dst = file.features[into];
  if (!src || !dst) return;
  const bySymbolId = new Map<string, FeatureSymbol>();
  for (const sym of dst.symbols) bySymbolId.set(sym.id, sym);
  for (const sym of src.symbols) {
    const prior = bySymbolId.get(sym.id);
    if (!prior) {
      bySymbolId.set(sym.id, sym);
      continue;
    }
    bySymbolId.set(sym.id, {
      id: sym.id,
      weight: Math.max(prior.weight, sym.weight),
      edits: prior.edits + sym.edits,
      reads: prior.reads + sym.reads,
      last_touched:
        prior.last_touched > sym.last_touched ? prior.last_touched : sym.last_touched,
    });
  }
  dst.symbols = Array.from(bySymbolId.values()).sort((a, b) => b.weight - a.weight);
  dst.aliases = Array.from(new Set([...(dst.aliases ?? []), from, ...(src.aliases ?? [])]));
  dst.sessions += src.sessions;
  dst.last_active = dst.last_active > src.last_active ? dst.last_active : src.last_active;
  delete file.features[from];
}
