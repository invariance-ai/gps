import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(_execFile);

export interface DiffResult {
  base: string;
  files: string[];
}

/**
 * Files changed between `base` and the working tree (staged + unstaged + untracked).
 * Best-effort: returns an empty file list outside a git repo.
 */
export async function changedFiles(root: string, base = "HEAD"): Promise<DiffResult> {
  try {
    const { stdout: tracked } = await execFile(
      "git",
      ["diff", "--name-only", base],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const { stdout: untracked } = await execFile(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const files = [...tracked.split("\n"), ...untracked.split("\n")]
      .map((s) => s.trim())
      .filter(Boolean);
    return { base, files: [...new Set(files)].sort() };
  } catch {
    return { base, files: [] };
  }
}

/**
 * Full unified diff text between `base` and the working tree, with default
 * context. Best-effort: returns "" outside a git repo or on failure. The doc
 * builder feeds this into splitDiffByFile for the local `gps doc --base` path.
 */
export async function diffText(root: string, base = "HEAD"): Promise<string> {
  try {
    const { stdout } = await execFile("git", ["diff", base], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}
