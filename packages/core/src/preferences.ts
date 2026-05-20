import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  Preference,
  type Preference as PreferenceT,
  type PreferenceScope,
  type PreferenceSource,
} from "@invariance/gps-schemas";

const REL = ".gps/preferences.yml";

export function preferencesPath(root: string): string {
  return path.join(root, REL);
}

function idFor(text: string): string {
  return createHash("sha1").update(text.trim().toLowerCase()).digest("hex").slice(0, 12);
}

export async function loadPreferences(root: string): Promise<PreferenceT[]> {
  try {
    const raw = await readFile(preferencesPath(root), "utf8");
    const data = parseYaml(raw);
    if (!Array.isArray(data)) return [];
    return data.map((d: unknown) => Preference.parse(d));
  } catch {
    return [];
  }
}

export interface AddPreferenceOpts {
  text: string;
  scope?: PreferenceScope;
  topic?: string;
  evidence?: string;
  source?: PreferenceSource;
}

export interface AddPreferenceResult {
  preference: PreferenceT;
  file: string;
  deduped: boolean;
}

export async function addPreference(
  root: string,
  opts: AddPreferenceOpts,
): Promise<AddPreferenceResult> {
  const id = idFor(opts.text);
  const existing = await loadPreferences(root);
  const dupe = existing.find((p) => p.id === id);
  if (dupe) {
    dupe.hits = (dupe.hits ?? 0) + 1;
    await persist(root, existing);
    return { preference: dupe, file: path.relative(root, preferencesPath(root)), deduped: true };
  }
  const pref: PreferenceT = Preference.parse({
    id,
    text: opts.text.trim(),
    scope: opts.scope ?? "repo",
    topic: opts.topic,
    evidence: opts.evidence,
    source: opts.source ?? "manual",
    recorded_at: new Date().toISOString(),
    hits: 0,
  });
  const next = [...existing, pref];
  await persist(root, next);
  return { preference: pref, file: path.relative(root, preferencesPath(root)), deduped: false };
}

async function persist(root: string, prefs: PreferenceT[]): Promise<void> {
  const file = preferencesPath(root);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stringifyYaml(prefs));
}

export async function removePreference(root: string, id: string): Promise<boolean> {
  const existing = await loadPreferences(root);
  const next = existing.filter((p) => p.id !== id);
  if (next.length === existing.length) return false;
  await persist(root, next);
  return true;
}

/**
 * Heuristic extractor: pull prescriptive user statements out of a prompt.
 * Matches lines/clauses that sound like durable preferences, e.g.:
 *   "from now on, keep PRs under 300 lines"
 *   "always run pnpm test before pushing"
 *   "i prefer terse explanations"
 *   "don't add comments unless asked"
 *
 * Conservative on purpose: false negatives are fine (user can `gps prefer`
 * manually); false positives spam the preferences file. Requires both a
 * directive cue and a meaningful predicate (>= 3 content words).
 */
const DIRECTIVE_CUES: Array<{ re: RegExp; strip: RegExp }> = [
  { re: /\bfrom now on[,:\s]+/i, strip: /^from now on[,:\s]+/i },
  { re: /\b(?:please\s+)?always\b/i, strip: /^\s*(?:please\s+)?/i },
  { re: /\b(?:please\s+)?never\b/i, strip: /^\s*(?:please\s+)?/i },
  { re: /\b(?:don'?t|do not)\b/i, strip: /^/ },
  { re: /\bi (?:prefer|want|like)\b/i, strip: /^/ },
  { re: /\bmake sure (?:to|you)\b/i, strip: /^/ },
  { re: /\bremember (?:to|that)\b/i, strip: /^remember (?:to|that)\s+/i },
  { re: /\b(?:we|you) should (?:always|never)?\s?/i, strip: /^/ },
];

const STOP_PREFIXES = [
  /^let'?s\s+/i,
  /^can you\s+/i,
  /^could you\s+/i,
  /^now\s+/i,
];

export function rankPreferences(
  prefs: PreferenceT[],
  symbolName: string,
  file: string,
  limit = 5,
): PreferenceT[] {
  if (prefs.length === 0) return [];
  const sym = symbolName.toLowerCase();
  const fileSeg = file.toLowerCase();
  const scored = prefs.map((p) => {
    const t = p.text.toLowerCase();
    const topic = (p.topic ?? "").toLowerCase();
    let score = 0;
    if (sym && (t.includes(sym) || topic.includes(sym))) score += 3;
    for (const seg of fileSeg.split(/[\/\\.]/).filter((s) => s.length > 3)) {
      if (t.includes(seg) || topic.includes(seg)) score += 1;
    }
    if (p.scope === "repo" || p.scope === "global") score += 0.5;
    score += Math.min((p.hits ?? 0) * 0.1, 1);
    return { p, score };
  });
  return scored
    .filter((s) => s.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.p);
}

export interface ExtractedPreference {
  text: string;
  cue: string;
}

export function extractPreferences(prompt: string): ExtractedPreference[] {
  if (!prompt || prompt.length > 8000) return [];
  const out: ExtractedPreference[] = [];
  const seen = new Set<string>();

  // Split into clause-sized chunks: line breaks, semicolons, periods, " — ".
  const chunks = prompt
    .split(/(?:\n+|(?<=[.;!?])\s+|\s+—\s+)/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && c.length < 240);

  for (const chunk of chunks) {
    const cue = DIRECTIVE_CUES.find((d) => d.re.test(chunk));
    if (!cue) continue;
    if (STOP_PREFIXES.some((re) => re.test(chunk))) continue;
    let text = chunk.replace(cue.strip, "").replace(/^[,:\s]+/, "").trim();
    text = text.replace(/[.!?]+$/, "").trim();
    if (text.split(/\s+/).filter((w) => w.length > 2).length < 3) continue;
    if (text.length > 200) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, cue: cue.re.source });
  }
  return out;
}
