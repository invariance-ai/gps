import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { ProvenanceEntry } from "@invariance/gps-schemas";

const execFile = promisify(_execFile);

const isRepoCache = new Map<string, boolean>();
const logCache = new Map<string, ProvenanceEntry[]>();
const churnCache = new Map<string, number>();

export function clearGitCache(): void {
  isRepoCache.clear();
  logCache.clear();
  churnCache.clear();
}

export async function isGitRepo(root: string): Promise<boolean> {
  const cached = isRepoCache.get(root);
  if (cached !== undefined) return cached;
  try {
    await execFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
    isRepoCache.set(root, true);
    return true;
  } catch {
    isRepoCache.set(root, false);
    return false;
  }
}

export async function logForFile(
  root: string,
  relFile: string,
  limit = 5,
): Promise<ProvenanceEntry[]> {
  const key = `${root}::${relFile}::${limit}`;
  const cached = logCache.get(key);
  if (cached) return cached;
  try {
    const { stdout } = await execFile(
      "git",
      ["log", `-n`, String(limit), "--format=%H%x09%an%x09%aI%x09%s", "--", relFile],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const out = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [commit, author, date, ...msg] = line.split("\t");
        return {
          commit: (commit ?? "").slice(0, 7),
          author: author ?? "",
          date: date ?? "",
          message: msg.join("\t"),
        };
      });
    logCache.set(key, out);
    return out;
  } catch {
    return [];
  }
}

export async function churn(root: string, relFile: string): Promise<number> {
  const key = `${root}::${relFile}`;
  const cached = churnCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const { stdout } = await execFile(
      "git",
      ["log", "--oneline", "--", relFile],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const n = stdout.trim() ? stdout.trim().split("\n").length : 0;
    churnCache.set(key, n);
    return n;
  } catch {
    return 0;
  }
}

export function toRelativePath(root: string, abs: string): string {
  return path.relative(root, abs);
}
