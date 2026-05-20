import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  Note,
  type NoteSeverity,
  type NoteSource,
  type Note as NoteT,
} from "@invariance/gps-schemas";

const DIR = ".gps/notes";
const FILE_DIR = ".gps/notes/file";
const FEATURE_DIR = ".gps/notes/feature";
const AREA_DIR = ".gps/notes/area";

function fileFor(root: string, symbol: string): string {
  // Symbols can contain `.` (Stripe.refunds.create) or `/` (path/to/sym).
  // Sanitize for filenames.
  const safe = symbol.replace(/[/\\:]/g, "__").replace(/\./g, "_");
  return path.join(root, DIR, `${safe}.yml`);
}

export function slugifyPath(p: string): string {
  return p.replace(/^\.\//, "").replace(/[/\\]/g, "__").replace(/\./g, "_");
}

function fileNotePath(root: string, file: string): string {
  return path.join(root, FILE_DIR, `${slugifyPath(file)}.yml`);
}

function featureNotePath(root: string, label: string): string {
  // labels are kebab-case already; lowercase to be safe
  return path.join(root, FEATURE_DIR, `${label.toLowerCase()}.yml`);
}

function areaNotePath(root: string, dir: string): string {
  return path.join(root, AREA_DIR, `${slugifyPath(dir)}.yml`);
}

export async function loadNotes(root: string, symbol: string): Promise<NoteT[]> {
  try {
    const raw = await readFile(fileFor(root, symbol), "utf8");
    const data = parseYaml(raw);
    if (!Array.isArray(data)) return [];
    return data.map((d: unknown) => Note.parse(d));
  } catch {
    return [];
  }
}

export interface AppendOpts {
  symbol: string;
  lesson: string;
  evidence?: string;
  severity?: NoteSeverity;
  source?: NoteSource;
}

export async function appendNote(
  root: string,
  opts: AppendOpts,
): Promise<{ note: NoteT; file: string }> {
  const note: NoteT = Note.parse({
    symbol: opts.symbol,
    lesson: opts.lesson,
    evidence: opts.evidence,
    severity: opts.severity ?? "medium",
    promoted: false,
    recorded_at: new Date().toISOString(),
    source: opts.source ?? "human",
  });
  const file = fileFor(root, opts.symbol);
  await mkdir(path.dirname(file), { recursive: true });
  const existing = await loadNotes(root, opts.symbol);
  const next = [...existing, note];
  await writeFile(file, stringifyYaml(next));
  return { note, file: path.relative(root, file) };
}

const SEV_RANK: Record<NoteSeverity, number> = { high: 0, medium: 1, low: 2 };

export function rankNotes(notes: NoteT[], limit = 5, includePromoted = false): NoteT[] {
  return notes
    .filter((n) => includePromoted || !n.promoted)
    .sort((a, b) => {
      const s = SEV_RANK[a.severity] - SEV_RANK[b.severity];
      if (s !== 0) return s;
      return b.recorded_at.localeCompare(a.recorded_at);
    })
    .slice(0, limit);
}

export async function loadFileNotes(root: string, file: string): Promise<NoteT[]> {
  try {
    const raw = await readFile(fileNotePath(root, file), "utf8");
    const data = parseYaml(raw);
    if (!Array.isArray(data)) return [];
    return data.map((d: unknown) => Note.parse(d));
  } catch {
    return [];
  }
}

export interface AppendScopedOpts {
  target: string;
  lesson: string;
  id: string;
  evidence?: string;
  severity?: NoteSeverity;
  source?: NoteSource;
  classifier?: NoteT["classifier"];
}

export async function appendFileNote(
  root: string,
  opts: AppendScopedOpts,
): Promise<{ note: NoteT; file: string }> {
  const note: NoteT = Note.parse({
    symbol: opts.target,
    lesson: opts.lesson,
    evidence: opts.evidence,
    severity: opts.severity ?? "medium",
    promoted: false,
    recorded_at: new Date().toISOString(),
    source: opts.source ?? "agent",
    id: opts.id,
    scope: "file",
    applies_to: opts.target,
    classifier: opts.classifier,
  });
  const out = fileNotePath(root, opts.target);
  await mkdir(path.dirname(out), { recursive: true });
  const existing = await loadFileNotes(root, opts.target);
  const next = [...existing, note];
  await writeFile(out, stringifyYaml(next));
  return { note, file: path.relative(root, out) };
}

export async function loadFeatureNotes(root: string, label: string): Promise<NoteT[]> {
  try {
    const raw = await readFile(featureNotePath(root, label), "utf8");
    const data = parseYaml(raw);
    if (!Array.isArray(data)) return [];
    return data.map((d: unknown) => Note.parse(d));
  } catch {
    return [];
  }
}

export async function appendFeatureNote(
  root: string,
  opts: AppendScopedOpts,
): Promise<{ note: NoteT; file: string }> {
  const note: NoteT = Note.parse({
    symbol: opts.target,
    lesson: opts.lesson,
    evidence: opts.evidence,
    severity: opts.severity ?? "medium",
    promoted: false,
    recorded_at: new Date().toISOString(),
    source: opts.source ?? "agent",
    id: opts.id,
    scope: "feature",
    applies_to: opts.target,
    classifier: opts.classifier,
  });
  const out = featureNotePath(root, opts.target);
  await mkdir(path.dirname(out), { recursive: true });
  const existing = await loadFeatureNotes(root, opts.target);
  const next = [...existing, note];
  await writeFile(out, stringifyYaml(next));
  return { note, file: path.relative(root, out) };
}

export async function loadAreaNotes(root: string, dir: string): Promise<NoteT[]> {
  try {
    const raw = await readFile(areaNotePath(root, dir), "utf8");
    const data = parseYaml(raw);
    if (!Array.isArray(data)) return [];
    return data.map((d: unknown) => Note.parse(d));
  } catch {
    return [];
  }
}

export async function appendAreaNote(
  root: string,
  opts: AppendScopedOpts,
): Promise<{ note: NoteT; file: string }> {
  const note: NoteT = Note.parse({
    symbol: opts.target,
    lesson: opts.lesson,
    evidence: opts.evidence,
    severity: opts.severity ?? "medium",
    promoted: false,
    recorded_at: new Date().toISOString(),
    source: opts.source ?? "agent",
    id: opts.id,
    scope: "area",
    applies_to: opts.target,
    classifier: opts.classifier,
  });
  const out = areaNotePath(root, opts.target);
  await mkdir(path.dirname(out), { recursive: true });
  const existing = await loadAreaNotes(root, opts.target);
  const next = [...existing, note];
  await writeFile(out, stringifyYaml(next));
  return { note, file: path.relative(root, out) };
}

/**
 * Walk a notes dir, returning [target, notes] pairs. Used by lessons listers.
 */
async function loadScopedDir(
  root: string,
  rel: string,
  unslug: (slug: string) => string,
): Promise<Array<{ target: string; notes: NoteT[]; path: string }>> {
  try {
    const dir = path.join(root, rel);
    const files = await readdir(dir);
    const out: Array<{ target: string; notes: NoteT[]; path: string }> = [];
    for (const f of files) {
      if (!f.endsWith(".yml")) continue;
      const raw = await readFile(path.join(dir, f), "utf8");
      const data = parseYaml(raw);
      if (!Array.isArray(data)) continue;
      const notes: NoteT[] = [];
      for (const d of data) {
        try {
          notes.push(Note.parse(d));
        } catch {
          /* skip malformed */
        }
      }
      out.push({
        target: unslug(f.replace(/\.yml$/, "")),
        notes,
        path: path.relative(root, path.join(dir, f)),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function loadAllFileNotes(
  root: string,
): Promise<Array<{ target: string; notes: NoteT[]; path: string }>> {
  return loadScopedDir(root, FILE_DIR, (slug) =>
    slug.replace(/__/g, "/").replace(/_/g, "."),
  );
}

export async function loadAllFeatureNotes(
  root: string,
): Promise<Array<{ target: string; notes: NoteT[]; path: string }>> {
  return loadScopedDir(root, FEATURE_DIR, (slug) => slug);
}

export async function loadAllAreaNotes(
  root: string,
): Promise<Array<{ target: string; notes: NoteT[]; path: string }>> {
  return loadScopedDir(root, AREA_DIR, (slug) =>
    slug.replace(/__/g, "/").replace(/_/g, "."),
  );
}

export async function removeNoteById(
  root: string,
  id: string,
): Promise<{ note: NoteT; path: string } | null> {
  const checks: Array<{
    dirRel: string;
    loader: (root: string, target: string) => Promise<NoteT[]>;
    pathFor: (root: string, target: string) => string;
    unslug: (slug: string) => string;
  }> = [
    {
      dirRel: DIR,
      loader: loadNotes,
      pathFor: fileFor,
      unslug: (s) => s.replace(/__/g, "/").replace(/_/g, "."),
    },
    {
      dirRel: FILE_DIR,
      loader: loadFileNotes,
      pathFor: fileNotePath,
      unslug: (s) => s.replace(/__/g, "/").replace(/_/g, "."),
    },
    {
      dirRel: FEATURE_DIR,
      loader: loadFeatureNotes,
      pathFor: featureNotePath,
      unslug: (s) => s,
    },
    {
      dirRel: AREA_DIR,
      loader: loadAreaNotes,
      pathFor: areaNotePath,
      unslug: (s) => s.replace(/__/g, "/").replace(/_/g, "."),
    },
  ];
  for (const { dirRel, loader, pathFor, unslug } of checks) {
    try {
      const dir = path.join(root, dirRel);
      const files = await readdir(dir);
      for (const f of files) {
        if (!f.endsWith(".yml")) continue;
        const target = unslug(f.replace(/\.yml$/, ""));
        const notes = await loader(root, target);
        const hit = notes.find((n) => n.id === id);
        if (!hit) continue;
        const next = notes.filter((n) => n.id !== id);
        const filePath = pathFor(root, target);
        if (next.length === 0) {
          await unlinkSafe(filePath);
        } else {
          await writeFile(filePath, stringifyYaml(next));
        }
        return { note: hit, path: path.relative(root, filePath) };
      }
    } catch {
      /* dir missing, continue */
    }
  }
  return null;
}

async function unlinkSafe(p: string): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(p);
  } catch {
    /* best-effort */
  }
}

/**
 * Mutate a single note by id across all scope directories.
 * Returns the updated note (and its file path) or null if not found.
 */
export async function updateNoteById(
  root: string,
  id: string,
  patch: Partial<NoteT>,
): Promise<{ note: NoteT; path: string } | null> {
  const dirs = [DIR, FILE_DIR, FEATURE_DIR, AREA_DIR];
  for (const dirRel of dirs) {
    try {
      const dir = path.join(root, dirRel);
      const files = await readdir(dir);
      for (const f of files) {
        if (!f.endsWith(".yml")) continue;
        const abs = path.join(dir, f);
        const raw = await readFile(abs, "utf8");
        const data = parseYaml(raw);
        if (!Array.isArray(data)) continue;
        let hit: NoteT | null = null;
        const next = data.map((d) => {
          try {
            const note = Note.parse(d);
            if (note.id !== id) return note;
            hit = Note.parse({ ...note, ...patch });
            return hit;
          } catch {
            return d as NoteT;
          }
        });
        if (hit) {
          await writeFile(abs, stringifyYaml(next));
          return { note: hit, path: path.relative(root, abs) };
        }
      }
    } catch {
      /* dir missing */
    }
  }
  return null;
}

export async function loadAllNotes(root: string): Promise<NoteT[]> {
  try {
    const files = await readdir(path.join(root, DIR));
    const out: NoteT[] = [];
    for (const f of files) {
      if (!f.endsWith(".yml")) continue;
      const raw = await readFile(path.join(root, DIR, f), "utf8");
      const data = parseYaml(raw);
      if (Array.isArray(data)) {
        for (const d of data) {
          try {
            out.push(Note.parse(d));
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

/**
 * Scan repo files for `TODO(symbol):` and `FIXME(symbol):` markers and lift
 * them into notes. One-shot day-zero corpus from comments your code already
 * carries. Re-running is idempotent: lessons collide on (symbol, lesson, source)
 * and dedupe.
 */
const TODO_RE = /(?:TODO|FIXME|XXX)\(([A-Za-z_$][\w$.]*)\)\s*:?\s*(.+)$/gm;

export interface TodoExtraction {
  symbol: string;
  lesson: string;
  evidence: string;
}

export function extractTodos(src: string, file: string): TodoExtraction[] {
  const out: TodoExtraction[] = [];
  for (const m of src.matchAll(TODO_RE)) {
    const symbol = m[1];
    const lesson = m[2]?.trim();
    if (!symbol || !lesson) continue;
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ symbol, lesson, evidence: `${file}:${line}` });
  }
  return out;
}
