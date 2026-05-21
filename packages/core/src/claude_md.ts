import { mkdir, readFile, rename, writeFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { NoteSeverity } from "@invariance/gps-schemas";

/**
 * Manages a single fenced block inside CLAUDE.md (or AGENTS.md) where gps
 * persists *global* lessons — repo-wide rules learned by an agent that don't
 * belong to one symbol/file/feature.
 *
 * Invariants:
 *  - Bytes outside the markers are never touched.
 *  - Writes are atomic (temp file + rename).
 *  - Lessons are id-keyed; upsert never duplicates.
 *  - A timestamped snapshot of the prior CLAUDE.md is kept under
 *    .gps/backups/ (last 5).
 *
 * Marker convention is distinct from the existing `gps:start`/`gps:end`
 * instruction block so install-time copy and learned lessons cannot collide.
 */

export const LESSONS_OPEN = "<!-- gps:global-lessons -->";
export const LESSONS_CLOSE = "<!-- /gps:global-lessons -->";

const LESSONS_BLOCK_RE =
  /<!-- gps:global-lessons -->([\s\S]*?)<!-- \/gps:global-lessons -->\n?/m;

export const PREFS_OPEN = "<!-- gps:auto-prefs -->";
export const PREFS_CLOSE = "<!-- /gps:auto-prefs -->";

export interface GlobalLesson {
  id: string;
  lesson: string;
  severity: NoteSeverity;
  recorded_at: string;
}

export function claudeMdPath(root: string, filename = "CLAUDE.md"): string {
  return path.join(root, filename);
}

function backupsDir(root: string): string {
  return path.join(root, ".gps/backups");
}

export function generateLessonId(): string {
  // 10 random bytes → 16-char base32-ish id. Cheap, no deps; collisions
  // negligible at the scale of one repo's lessons.
  return randomBytes(8).toString("hex");
}

const ENTRY_RE =
  /^- \[(?<id>[a-z0-9]+)\] \[(?<sev>low|medium|high)\] (?<lesson>.+?) — (?<at>\S+)$/;

function parseEntries(block: string): GlobalLesson[] {
  const out: GlobalLesson[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line || !line.startsWith("- [")) continue;
    const m = ENTRY_RE.exec(line);
    if (!m?.groups) continue;
    out.push({
      id: m.groups.id!,
      severity: m.groups.sev as NoteSeverity,
      lesson: m.groups.lesson!,
      recorded_at: m.groups.at!,
    });
  }
  return out;
}

function renderEntries(lessons: GlobalLesson[]): string {
  const header = "## gps global lessons\n\n_Auto-managed by `gps lessons record`. Edit via the CLI; freeform notes above/below are preserved._\n\n";
  if (lessons.length === 0) return header.trim() + "\n";
  return (
    header +
    lessons
      .map(
        (l) =>
          `- [${l.id}] [${l.severity}] ${l.lesson.replace(/\n+/g, " ")} — ${l.recorded_at}`,
      )
      .join("\n") +
    "\n"
  );
}

async function readFileOrEmpty(p: string): Promise<string> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return "";
  }
}

export async function readGlobalLessons(
  root: string,
  filename = "CLAUDE.md",
): Promise<GlobalLesson[]> {
  const existing = await readFileOrEmpty(claudeMdPath(root, filename));
  const m = LESSONS_BLOCK_RE.exec(existing);
  if (!m) return [];
  return parseEntries(m[1] ?? "");
}

async function snapshot(root: string, content: string): Promise<void> {
  if (!content) return;
  const dir = backupsDir(root);
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  await writeFile(path.join(dir, `CLAUDE.md.${ts}`), content);
  // Trim to last 5.
  try {
    const entries = (await readdir(dir))
      .filter((f) => f.startsWith("CLAUDE.md."))
      .sort()
      .reverse();
    for (const stale of entries.slice(5)) {
      await unlink(path.join(dir, stale)).catch(() => undefined);
    }
  } catch {
    /* best-effort */
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, content);
  await rename(tmp, file);
}

/**
 * Upsert a single lesson into the managed block. If an entry with the same id
 * exists, replace it; else append. Bytes outside the markers are untouched.
 */
export async function upsertGlobalLesson(
  root: string,
  lesson: GlobalLesson,
  filename = "CLAUDE.md",
): Promise<{ path: string }> {
  const file = claudeMdPath(root, filename);
  const existing = await readFileOrEmpty(file);
  await snapshot(root, existing);

  const m = LESSONS_BLOCK_RE.exec(existing);
  const current = m ? parseEntries(m[1] ?? "") : [];

  const next = current.filter((l) => l.id !== lesson.id);
  next.push(lesson);

  const blockBody = renderEntries(next);
  const block = `${LESSONS_OPEN}\n${blockBody}${LESSONS_CLOSE}\n`;

  const updated = m
    ? existing.replace(LESSONS_BLOCK_RE, block)
    : existing.trimEnd().length > 0
      ? `${existing.trimEnd()}\n\n${block}`
      : block;

  await atomicWrite(file, updated);
  return { path: path.relative(root, file) };
}

export async function removeGlobalLesson(
  root: string,
  id: string,
  filename = "CLAUDE.md",
): Promise<{ removed: GlobalLesson | null; path: string }> {
  const file = claudeMdPath(root, filename);
  const existing = await readFileOrEmpty(file);
  const m = LESSONS_BLOCK_RE.exec(existing);
  if (!m) return { removed: null, path: path.relative(root, file) };
  await snapshot(root, existing);

  const current = parseEntries(m[1] ?? "");
  const removed = current.find((l) => l.id === id) ?? null;
  if (!removed) return { removed: null, path: path.relative(root, file) };

  const next = current.filter((l) => l.id !== id);
  const blockBody = renderEntries(next);
  const block = `${LESSONS_OPEN}\n${blockBody}${LESSONS_CLOSE}\n`;
  const updated = existing.replace(LESSONS_BLOCK_RE, block);
  await atomicWrite(file, updated);
  return { removed, path: path.relative(root, file) };
}

/**
 * Plain-text body of the lessons block, used by the read path for
 * substring-dedup against scoped notes about to be injected.
 */
export async function readGlobalLessonsBody(
  root: string,
  filename = "CLAUDE.md",
): Promise<string> {
  const existing = await readFileOrEmpty(claudeMdPath(root, filename));
  const m = LESSONS_BLOCK_RE.exec(existing);
  return (m?.[1] ?? "").toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function managedBlockRe(open: string, close: string): RegExp {
  return new RegExp(`${escapeRe(open)}([\\s\\S]*?)${escapeRe(close)}\\n?`, "m");
}

/**
 * Replace (or insert) a fully-regenerated managed block delimited by
 * `open`/`close` markers. Unlike upsertGlobalLesson (incremental, id-keyed),
 * this overwrites the whole block from a caller-owned source of truth — used
 * for the auto-prefs block, which is regenerated from .gps/preferences.yml on
 * every SessionStart. Bytes outside the markers are untouched; no-ops (and
 * skips the backup) when the block is already byte-identical.
 */
export async function upsertManagedBlock(
  root: string,
  open: string,
  close: string,
  body: string,
  filename = "CLAUDE.md",
): Promise<{ path: string; changed: boolean }> {
  const file = claudeMdPath(root, filename);
  const existing = await readFileOrEmpty(file);
  const re = managedBlockRe(open, close);
  const block = `${open}\n${body.trimEnd()}\n${close}\n`;
  const m = re.exec(existing);
  if (m && m[0].replace(/\n+$/, "") === block.replace(/\n+$/, "")) {
    return { path: path.relative(root, file), changed: false };
  }
  await snapshot(root, existing);
  const updated = m
    ? existing.replace(re, block)
    : existing.trimEnd().length > 0
      ? `${existing.trimEnd()}\n\n${block}`
      : block;
  await atomicWrite(file, updated);
  return { path: path.relative(root, file), changed: true };
}

/** Remove a managed block if present. Bytes outside the markers are untouched. */
export async function removeManagedBlock(
  root: string,
  open: string,
  close: string,
  filename = "CLAUDE.md",
): Promise<{ path: string; changed: boolean }> {
  const file = claudeMdPath(root, filename);
  const existing = await readFileOrEmpty(file);
  const re = managedBlockRe(open, close);
  if (!re.test(existing)) return { path: path.relative(root, file), changed: false };
  await snapshot(root, existing);
  const updated = existing.replace(re, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  await atomicWrite(file, updated);
  return { path: path.relative(root, file), changed: true };
}
