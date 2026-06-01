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

/** The well-known SHA of git's empty tree — the synthetic parent of a root commit. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Unified diff between two arbitrary refs (`git diff <from> <to>`). This is
 * **read-only** — it never touches the working tree — so it is safe to diff
 * historical commits while the user has uncommitted work. Best-effort: returns
 * "" on failure / outside a git repo.
 */
export async function diffBetween(root: string, from: string, to: string): Promise<string> {
  try {
    const { stdout } = await execFile("git", ["diff", from, to], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

export interface CommitMeta {
  sha: string;
  author: string;
  date: string;
  message: string;
}

/**
 * Commits reachable from `head` but not `base` (`base..head`), oldest → newest.
 * Read-only. Best-effort: returns [] on failure / outside a git repo.
 */
export async function commitsBetween(
  root: string,
  base: string,
  head = "HEAD",
): Promise<CommitMeta[]> {
  try {
    const { stdout } = await execFile(
      "git",
      ["log", "--reverse", "--format=%H%x09%an%x09%aI%x09%s", `${base}..${head}`],
      { cwd: root, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, author, date, ...msg] = line.split("\t");
        return {
          sha: sha ?? "",
          author: author ?? "",
          date: date ?? "",
          message: msg.join("\t"),
        };
      });
  } catch {
    return [];
  }
}

/**
 * Best-effort default base for a history walk: the merge-base of `head` with the
 * remote's default branch (`origin/HEAD`). Returns undefined when there's no
 * remote default / not a repo, so the caller can ask for an explicit `--base`.
 * Read-only.
 */
export async function resolveDefaultBase(
  root: string,
  head = "HEAD",
): Promise<string | undefined> {
  try {
    const { stdout: def } = await execFile(
      "git",
      ["rev-parse", "--abbrev-ref", "origin/HEAD"],
      { cwd: root },
    );
    const remoteDefault = def.trim();
    if (remoteDefault) {
      const { stdout: mb } = await execFile("git", ["merge-base", remoteDefault, head], {
        cwd: root,
      });
      if (mb.trim()) return mb.trim();
    }
  } catch {
    // No remote default / not a repo — fall through to undefined.
  }
  return undefined;
}

/**
 * The parent ref of a commit (`<sha>^`). For a root commit (no parent), returns
 * the empty-tree SHA so `diffBetween(parent, sha)` shows the whole commit as
 * additions. Read-only.
 */
export async function parentOf(root: string, sha: string): Promise<string> {
  try {
    const { stdout } = await execFile("git", ["rev-parse", "--verify", `${sha}^`], {
      cwd: root,
    });
    const parent = stdout.trim();
    return parent || EMPTY_TREE;
  } catch {
    // Root commit (or unknown ref): diff against the empty tree.
    return EMPTY_TREE;
  }
}
