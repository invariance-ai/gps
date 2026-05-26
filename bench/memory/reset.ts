/**
 * Working-tree reset helpers for the memory benchmark.
 *
 * The core harness's `resetWorkingTree` (packages/core/src/bench.ts) deliberately
 * `rm -r .gps .mcp.json` between attempts — correct for the edit benchmark, FATAL here,
 * because cross-session memory lives in `.gps/`. So the memory runner uses these:
 *   - resetCodeOnly: undo code edits but PRESERVE `.gps/` and `.mcp.json` (between test sessions)
 *   - wipeMemory:    remove `.gps/` (the baseline arm, before each test session)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);

async function assertGitRepo(repo: string): Promise<void> {
  try {
    await exec("git", ["-C", repo, "rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new Error(
      `${repo} is not a git repo; refusing to reset (cannot guarantee a clean state otherwise).`,
    );
  }
}

/**
 * Discard tracked edits and remove stray untracked files, but keep gps memory + the
 * MCP config so the next test session in the same trial still has what was taught.
 */
export async function resetCodeOnly(repo: string): Promise<void> {
  await assertGitRepo(repo);
  await exec("git", ["-C", repo, "checkout", "--", "."]);
  // `-e` keeps these untracked paths; everything else untracked is removed.
  await exec("git", ["-C", repo, "clean", "-fd", "-e", ".gps", "-e", ".mcp.json"]);
}

/** Remove all persisted gps memory. Used by the baseline arm before every test session. */
export async function wipeMemory(repo: string): Promise<void> {
  await rm(path.join(repo, ".gps"), { recursive: true, force: true });
}

/** Full scrub (code + memory + mcp). Used to start a brand-new trial from a known state. */
export async function resetAll(repo: string): Promise<void> {
  await assertGitRepo(repo);
  await exec("git", ["-C", repo, "checkout", "--", "."]);
  await exec("git", ["-C", repo, "clean", "-fd"]);
  await rm(path.join(repo, ".gps"), { recursive: true, force: true });
  await rm(path.join(repo, ".mcp.json"), { force: true });
}
