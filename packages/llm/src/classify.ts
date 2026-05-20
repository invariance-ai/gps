import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { NoteScope } from "@invariance/gps-schemas";
import { GpsLlm } from "./client.js";

/**
 * LLM tie-breaker for lesson scope classification. Used only when heuristic
 * confidence is low. Returns the heuristic top label on any failure so the
 * caller can never be blocked by network/auth issues.
 *
 * Cached by content-hash under .gps/cache/classify.json so repeated
 * lessons (and dry-runs) don't burn tokens.
 */

const CACHE_REL = ".gps/cache/classify.json";

export interface ClassifyCandidates {
  symbols: string[];
  files: string[];
  features: string[];
  areas?: string[];
}

export interface ClassifyDecision {
  scope: NoteScope;
  target?: string;
  reason: string;
}

interface CacheFile {
  version: 1;
  entries: Record<string, ClassifyDecision>;
}

function hashKey(lesson: string, cands: ClassifyCandidates): string {
  const h = createHash("sha256");
  h.update(lesson);
  h.update("\0");
  h.update(cands.symbols.sort().join(","));
  h.update("\0");
  h.update(cands.files.sort().join(","));
  h.update("\0");
  h.update(cands.features.sort().join(","));
  h.update("\0");
  h.update((cands.areas ?? []).slice().sort().join(","));
  return h.digest("hex").slice(0, 16);
}

async function loadCache(root: string): Promise<CacheFile> {
  try {
    const raw = await readFile(path.join(root, CACHE_REL), "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed.version === 1 && parsed.entries) return parsed;
  } catch {
    /* missing or corrupt — start fresh */
  }
  return { version: 1, entries: {} };
}

async function saveCache(root: string, cache: CacheFile): Promise<void> {
  const p = path.join(root, CACHE_REL);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(cache, null, 2));
}

const SYSTEM = `You label engineering lessons by scope. Return STRICT JSON: {"scope": "...", "target": "...", "reason": "..."}.

scope ∈ {"global", "symbol", "file", "feature", "area"}:
- global: rule applies repo-wide regardless of file or symbol ("always X", "the codebase…", policy).
- symbol: rule is only true for one named function/class/method.
- file: rule is only true for one specific file/module path.
- feature: rule applies to a feature cluster (auth, refunds, billing, etc.).
- area: rule applies to a location/directory ("here", "this folder", "the home page").

Prefer the NARROWEST scope that's still true.
The "target" must be one of the provided candidates for non-global scopes; omit it for global.
"reason" is a short phrase (<= 12 words). No prose outside the JSON.`;

function buildUserPrompt(
  lesson: string,
  cands: ClassifyCandidates,
  heuristicSignals: string[],
): string {
  return [
    `Lesson:`,
    lesson,
    ``,
    `Candidate symbols: ${cands.symbols.length ? cands.symbols.join(", ") : "(none)"}`,
    `Candidate files:   ${cands.files.length ? cands.files.join(", ") : "(none)"}`,
    `Candidate features:${cands.features.length ? " " + cands.features.join(", ") : " (none)"}`,
    `Candidate areas:   ${cands.areas?.length ? cands.areas.join(", ") : "(none)"}`,
    `Heuristic signals: ${heuristicSignals.length ? heuristicSignals.join(", ") : "(none)"}`,
    ``,
    `Return JSON only.`,
  ].join("\n");
}

function tryParseDecision(raw: string): ClassifyDecision | null {
  // Strip ``` fences / extra prose if any.
  const m = raw.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as { scope?: string; target?: string; reason?: string };
    if (!obj.scope) return null;
    const valid: NoteScope[] = ["global", "symbol", "file", "feature", "area"];
    if (!valid.includes(obj.scope as NoteScope)) return null;
    return {
      scope: obj.scope as NoteScope,
      target: typeof obj.target === "string" && obj.target.length > 0 ? obj.target : undefined,
      reason: typeof obj.reason === "string" ? obj.reason : "",
    };
  } catch {
    return null;
  }
}

export interface ClassifyOptions {
  /** Skip LLM, return heuristic fallback. */
  offline?: boolean;
  /** Override model (default: claude-haiku-4-5-20251001). */
  model?: string;
  /** Compute the prompt but don't hit the API. */
  dryRun?: boolean;
}

export async function llmClassify(
  root: string,
  lesson: string,
  candidates: ClassifyCandidates,
  heuristicSignals: string[],
  heuristicFallback: ClassifyDecision,
  opts: ClassifyOptions = {},
): Promise<{ decision: ClassifyDecision; used_llm: boolean; model?: string }> {
  const offline = opts.offline || process.env.GPS_CLASSIFY_OFFLINE === "1";
  if (offline) return { decision: heuristicFallback, used_llm: false };

  const key = hashKey(lesson, candidates);
  const cache = await loadCache(root);
  const cached = cache.entries[key];
  if (cached) return { decision: cached, used_llm: false };

  const model = opts.model ?? "claude-haiku-4-5-20251001";
  let llm: GpsLlm;
  try {
    llm = new GpsLlm({ model, dryRun: !!opts.dryRun });
  } catch {
    return { decision: heuristicFallback, used_llm: false };
  }

  let text: string;
  try {
    const res = await llm.complete({
      system: SYSTEM,
      user: buildUserPrompt(lesson, candidates, heuristicSignals),
      maxTokens: 256,
    });
    text = res.text;
  } catch {
    return { decision: heuristicFallback, used_llm: false };
  }

  const parsed = tryParseDecision(text);
  if (!parsed) return { decision: heuristicFallback, used_llm: false };

  cache.entries[key] = parsed;
  await saveCache(root, cache).catch(() => undefined);
  return { decision: parsed, used_llm: true, model };
}
