import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const REL = ".gps/pending-lessons.json";

export const DEFAULT_CONFIDENCE_GATE = 0.75;
export const DEFAULT_COUNT_GATE = 2;

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
}

/**
 * Record an observation of a candidate global lesson. Increments the count and
 * updates max confidence seen. Returns promoted=true when both gates pass.
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
  const id = idFor(text);
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
