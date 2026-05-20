import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { Note, Decision } from "@invariance/gps-schemas";
import { isGitRepo } from "./git.js";

const execFile = promisify(_execFile);

export interface SyncOptions {
  remote?: string;
  branch?: string;
  push?: boolean;
}

export interface SyncResult {
  pulled: boolean;
  pushed: boolean;
  merged_notes: number;
  merged_decisions: number;
  conflicts: string[];
}

/**
 * Sync .gps/ via the repo's own git remote.
 * Strategy: fetch + merge with a union strategy on .gps/**, then dedupe note/decision YAMLs
 * by id (or by content hash when id absent).
 */
export async function syncGps(root: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const out: SyncResult = {
    pulled: false,
    pushed: false,
    merged_notes: 0,
    merged_decisions: 0,
    conflicts: [],
  };
  if (!(await isGitRepo(root))) return out;

  const remote = opts.remote ?? "origin";
  const branch = opts.branch ?? (await currentBranch(root));

  try {
    await git(root, ["fetch", remote, branch]);
    try {
      await git(root, ["merge", "--no-edit", `${remote}/${branch}`, "--strategy-option=union"]);
      out.pulled = true;
    } catch {
      // merge failed — try to resolve conflicts inside .gps/ via union dedupe.
      const conflicted = await conflictedGpsPaths(root);
      out.conflicts = conflicted;
      for (const f of conflicted) {
        await dedupeYamlFile(root, f);
        await git(root, ["add", f]);
      }
      if (conflicted.length > 0) {
        try {
          await git(root, ["commit", "--no-edit", "-m", "gps: union-merge .gps/"]);
          out.pulled = true;
        } catch {
          /* leave for human */
        }
      }
    }
  } catch {
    /* nothing to fetch */
  }

  // Walk .gps/notes and .gps/decisions and dedupe entries.
  out.merged_notes = await dedupeDir(root, ".gps/notes", parseNote);
  out.merged_decisions = await dedupeDir(root, ".gps/decisions", parseDecision);

  if (opts.push) {
    try {
      await git(root, ["push", remote, branch]);
      out.pushed = true;
    } catch {
      /* leave */
    }
  }
  return out;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function currentBranch(root: string): Promise<string> {
  try {
    return (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    return "main";
  }
}

async function conflictedGpsPaths(root: string): Promise<string[]> {
  try {
    const stdout = await git(root, ["diff", "--name-only", "--diff-filter=U"]);
    return stdout.split("\n").map((s) => s.trim()).filter((s) => s.startsWith(".gps/"));
  } catch {
    return [];
  }
}

async function dedupeYamlFile(root: string, rel: string): Promise<void> {
  try {
    const abs = path.join(root, rel);
    const raw = await readFile(abs, "utf8");
    // strip git conflict markers and union the chunks.
    const cleaned = raw.replace(/<<<<<<<[^\n]*\n|=======\n|>>>>>>>[^\n]*\n/g, "");
    const data = parseYaml(cleaned);
    if (!Array.isArray(data)) return;
    const dedup = dedupeEntries(data);
    await writeFile(abs, stringifyYaml(dedup));
  } catch {
    /* leave */
  }
}

function parseNote(d: unknown): unknown | null {
  try {
    return Note.parse(d);
  } catch {
    return null;
  }
}
function parseDecision(d: unknown): unknown | null {
  try {
    return Decision.parse(d);
  } catch {
    return null;
  }
}

async function dedupeDir(
  root: string,
  rel: string,
  parser: (d: unknown) => unknown | null,
): Promise<number> {
  let total = 0;
  try {
    const dir = path.join(root, rel);
    await mkdir(dir, { recursive: true });
    const files = await readdir(dir);
    for (const f of files) {
      if (!f.endsWith(".yml")) continue;
      const abs = path.join(dir, f);
      const raw = await readFile(abs, "utf8");
      let data: unknown;
      try {
        data = parseYaml(raw);
      } catch {
        continue;
      }
      if (!Array.isArray(data)) continue;
      const valid = data.map(parser).filter((x): x is unknown => x !== null);
      const dedup = dedupeEntries(valid);
      if (dedup.length !== data.length) {
        await writeFile(abs, stringifyYaml(dedup));
      }
      total += dedup.length;
    }
  } catch {
    /* dir missing */
  }
  return total;
}

function dedupeEntries(items: unknown[]): unknown[] {
  const byKey = new Map<string, unknown>();
  for (const it of items) {
    const obj = it as Record<string, unknown>;
    const id = (obj?.id as string | undefined) ?? "";
    const lesson = (obj?.lesson as string | undefined) ?? "";
    const decision = (obj?.decision as string | undefined) ?? "";
    const symbol = (obj?.symbol as string | undefined) ?? "";
    const key = id || `${symbol}::${lesson || decision}`.slice(0, 240);
    if (!byKey.has(key)) byKey.set(key, it);
  }
  return [...byKey.values()];
}
