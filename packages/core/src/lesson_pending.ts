import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { tokenize, jaccard } from "./text_similarity.js";

const REL = ".gps/pending-lessons.json";

export const DEFAULT_CONFIDENCE_GATE = 0.75;
export const DEFAULT_COUNT_GATE = 2;
/**
 * Lexical-overlap threshold above which a new observation is treated as a
 * recurrence of an existing pending lesson (reworded), folding onto the same
 * counter instead of minting a fresh id. Higher than promote.ts's clustering
 * gate (0.4) — folding is destructive to the count, so we want real overlap.
 */
export const DEFAULT_SIMILARITY_GATE = 0.5;

export interface PendingLesson {
  id: string;
  text: string;
  confidence: number;
  count: number;
  first_seen: string;
  last_seen: string;
}

interface PendingFile {
  version: 1;
  lessons: Record<string, PendingLesson>;
}

function pendingPath(root: string): string {
  return path.join(root, REL);
}

function idFor(text: string): string {
  return createHash("sha1").update(text.trim().toLowerCase()).digest("hex").slice(0, 12);
}

async function load(root: string): Promise<PendingFile> {
  try {
    const raw = await readFile(pendingPath(root), "utf8");
    const data = JSON.parse(raw);
    if (data && data.version === 1 && data.lessons) return data as PendingFile;
  } catch {
    /* fall through */
  }
  return { version: 1, lessons: {} };
}

async function persist(root: string, file: PendingFile): Promise<void> {
  const target = pendingPath(root);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(file, null, 2));
  await rename(tmp, target);
}

export interface ObservationResult {
  promoted: boolean;
  pending: PendingLesson;
}

export interface GateOpts {
  confidenceGate?: number;
  countGate?: number;
  /** Lexical-overlap threshold for folding reworded recurrences (default 0.5). */
  similarityGate?: number;
}

/**
 * Find an existing pending lesson that is a reworded version of `text`
 * (Jaccard overlap ≥ gate), so recurrences accumulate on one counter rather
 * than fragmenting across near-duplicate ids. Returns the best match's id.
 */
function findSimilarId(
  lessons: Record<string, PendingLesson>,
  text: string,
  gate: number,
): string | null {
  const incoming = tokenize(text);
  let bestId: string | null = null;
  let bestScore = gate;
  for (const [id, p] of Object.entries(lessons)) {
    const score = jaccard(incoming, tokenize(p.text));
    if (score >= bestScore) {
      bestScore = score;
      bestId = id;
    }
  }
  return bestId;
}

/**
 * Record an observation of a candidate global lesson. Increments the count and
 * updates max confidence seen. Reworded recurrences fold onto the same pending
 * entry (see findSimilarId). Returns promoted=true when both gates pass.
 *
 * The caller is responsible for actually writing CLAUDE.md when promoted; this
 * module only tracks the gate state.
 */
export async function recordLessonObservation(
  root: string,
  text: string,
  confidence: number,
  opts: GateOpts = {},
): Promise<ObservationResult> {
  const file = await load(root);
  const exactId = idFor(text);
  // Exact hash wins; otherwise fold onto a sufficiently-similar pending lesson.
  const id =
    file.lessons[exactId]
      ? exactId
      : findSimilarId(file.lessons, text, opts.similarityGate ?? DEFAULT_SIMILARITY_GATE) ??
        exactId;
  const now = new Date().toISOString();
  const existing = file.lessons[id];
  const pending: PendingLesson = existing
    ? {
        ...existing,
        confidence: Math.max(existing.confidence, confidence),
        count: existing.count + 1,
        last_seen: now,
      }
    : {
        id,
        text: text.trim(),
        confidence,
        count: 1,
        first_seen: now,
        last_seen: now,
      };
  file.lessons[id] = pending;
  await persist(root, file);

  const confGate = opts.confidenceGate ?? DEFAULT_CONFIDENCE_GATE;
  const countGate = opts.countGate ?? DEFAULT_COUNT_GATE;
  const promoted = pending.confidence >= confGate && pending.count >= countGate;
  return { promoted, pending };
}

export async function listPending(root: string): Promise<PendingLesson[]> {
  const file = await load(root);
  return Object.values(file.lessons);
}

export async function clearPending(root: string, id: string): Promise<boolean> {
  const file = await load(root);
  if (!file.lessons[id]) return false;
  delete file.lessons[id];
  await persist(root, file);
  return true;
}
