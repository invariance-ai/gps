import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(_execFile);

/**
 * Shells out to the `gh` CLI. Returns null when gh is unavailable or the
 * call fails — callers fall back to `--diff-file` etc.
 */
export interface PrSnapshot {
  number: number;
  title: string;
  body: string;
  diff: string;
  files: string[];
}

export async function ghAvailable(): Promise<boolean> {
  try {
    await execFile("gh", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export async function fetchPr(prNumber: number | string): Promise<PrSnapshot | null> {
  if (!(await ghAvailable())) return null;
  try {
    const { stdout: meta } = await execFile(
      "gh",
      ["pr", "view", String(prNumber), "--json", "number,title,body,files"],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const m = JSON.parse(meta) as {
      number: number;
      title: string;
      body: string;
      files: Array<{ path: string }>;
    };
    const { stdout: diff } = await execFile("gh", ["pr", "diff", String(prNumber)], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      number: m.number,
      title: m.title,
      body: m.body ?? "",
      diff,
      files: m.files.map((f) => f.path),
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort PR number for the current branch via `gh pr view`. Returns null
 * when gh is unavailable, there's no associated PR, or the call fails. Used by
 * the doc auto-hook to decide between a PR doc and a local-diff doc.
 */
export async function currentPrNumber(root: string): Promise<number | null> {
  if (!(await ghAvailable())) return null;
  try {
    const { stdout } = await execFile("gh", ["pr", "view", "--json", "number"], {
      cwd: root,
    });
    const m = JSON.parse(stdout) as { number?: number };
    return typeof m.number === "number" ? m.number : null;
  } catch {
    return null;
  }
}

export interface PrThread {
  number: number;
  title: string;
  body: string;
  files: string[];
  reviews: Array<{ author: string; body: string; state: string }>;
  comments: Array<{ author: string; body: string }>;
  labels: string[];
}

export async function fetchPrThread(
  prNumber: number | string,
): Promise<PrThread | null> {
  if (!(await ghAvailable())) return null;
  try {
    const { stdout } = await execFile(
      "gh",
      [
        "pr",
        "view",
        String(prNumber),
        "--json",
        "number,title,body,files,reviews,comments,labels",
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const m = JSON.parse(stdout) as {
      number: number;
      title: string;
      body: string;
      files: Array<{ path: string }>;
      reviews: Array<{ author: { login?: string }; body: string; state: string }>;
      comments: Array<{ author: { login?: string }; body: string }>;
      labels?: Array<{ name: string }>;
    };
    return {
      number: m.number,
      title: m.title,
      body: m.body ?? "",
      files: m.files.map((f) => f.path),
      reviews: (m.reviews ?? []).map((r) => ({
        author: r.author?.login ?? "unknown",
        body: r.body ?? "",
        state: r.state,
      })),
      comments: (m.comments ?? []).map((c) => ({
        author: c.author?.login ?? "unknown",
        body: c.body ?? "",
      })),
      labels: (m.labels ?? []).map((l) => l.name),
    };
  } catch {
    return null;
  }
}

export function flattenPrThread(t: PrThread): string {
  const parts: string[] = [];
  parts.push(`# PR #${t.number}: ${t.title}`);
  parts.push("");
  if (t.body) {
    parts.push("## Description");
    parts.push(t.body);
    parts.push("");
  }
  if (t.reviews.length > 0) {
    parts.push("## Reviews");
    for (const r of t.reviews) {
      parts.push(`### ${r.author} (${r.state})`);
      if (r.body) parts.push(r.body);
      parts.push("");
    }
  }
  if (t.comments.length > 0) {
    parts.push("## Comments");
    for (const c of t.comments) {
      parts.push(`### ${c.author}`);
      if (c.body) parts.push(c.body);
      parts.push("");
    }
  }
  return parts.join("\n");
}
