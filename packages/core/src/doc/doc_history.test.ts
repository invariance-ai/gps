import { execFile as _execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DocHistory, DocSnapshot } from "@invariance/gps-schemas";
import { captureDocHistory, loadDocHistory } from "./doc_history.js";
import { commitsBetween, diffBetween, parentOf } from "../git_diff.js";
import type { LlmAnnotator } from "./doc_model.js";
import { clearIndexCache } from "../index_store.js";
import { clearGitCache } from "../git.js";

const execFile = promisify(_execFile);
const roots: string[] = [];

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd: root });
  return stdout.trim();
}

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-doc-history-"));
  roots.push(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "t@example.com");
  await git(root, "config", "user.name", "Tester");
  await git(root, "config", "commit.gpgsign", "false");
  return root;
}

async function commit(root: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(path.join(root, file), content);
  await git(root, "add", ".");
  await git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
  clearIndexCache();
  clearGitCache();
});

/** Annotator that records how many times it was invoked. */
function countingAnnotator(): { fn: LlmAnnotator; calls: () => number } {
  let calls = 0;
  const fn: LlmAnnotator = async (reqs) => {
    calls++;
    return reqs.map((r) => ({
      file: r.file,
      start_line: r.start_line,
      end_line: r.end_line,
      text: "LLM gloss",
      kind: "llm" as const,
      source: "llm",
    }));
  };
  return { fn, calls: () => calls };
}

describe("read-only git helpers", () => {
  it("diff/commits/parent never touch the working tree", async () => {
    const root = await tempRepo();
    const base = await commit(root, "a.ts", "export const a = 1;\n", "base");
    await commit(root, "a.ts", "export const a = 2;\nexport const b = 3;\n", "second");
    // Leave an uncommitted change in the tree.
    await writeFile(path.join(root, "a.ts"), "dirty working copy\n");

    const before = await git(root, "status", "--porcelain");
    const commits = await commitsBetween(root, base, "HEAD");
    const parent = await parentOf(root, commits[0]!.sha);
    const diff = await diffBetween(root, parent, commits[0]!.sha);
    const after = await git(root, "status", "--porcelain");

    expect(before).toBe(after); // working tree untouched
    expect(commits).toHaveLength(1);
    expect(commits[0]!.message).toBe("second");
    expect(diff).toContain("export const b = 3;");
  }, 30_000);
});

describe("captureDocHistory", () => {
  // `maxDiffBytes: 1` forces every snapshot over budget, which skips annotation
  // collection + parser load — keeping the structural tests fast and robust
  // under full-suite parallelism. The LLM-gating test below opts back in.
  const FAST = { maxDiffBytes: 1 } as const;

  it("snapshots one entry per new commit, dedupes, and never touches the tree", async () => {
    const root = await tempRepo();
    const base = await commit(root, "a.ts", "export const a = 1;\n", "base");
    await commit(root, "a.ts", "export const a = 2;\n", "second");
    await commit(root, "b.ts", "export const b = 1;\n", "third");

    const first = await captureDocHistory(root, { base, llmFill: false, ...FAST });
    expect(first.added).toBe(2);
    expect(first.total).toBe(2);

    const before = await git(root, "status", "--porcelain");
    const second = await captureDocHistory(root, { base, llmFill: false, ...FAST });
    const after = await git(root, "status", "--porcelain");
    expect(second.added).toBe(0); // idempotent
    expect(second.total).toBe(2);
    expect(before).toBe(after); // working tree untouched across captures
  }, 30_000);

  it("runs LLM gap-fill only on the tip snapshot", async () => {
    const root = await tempRepo();
    const base = await commit(root, "a.ts", "export const a = 1;\n", "base");
    await commit(root, "a.ts", "export const a = 2;\n", "second");
    await commit(root, "b.ts", "export const b = 1;\n", "third");

    const ann = countingAnnotator();
    await captureDocHistory(root, { base, annotate: ann.fn, llmFill: true });
    expect(ann.calls()).toBe(1); // cost gate: tip only

    const history = await loadDocHistory(root, `repo-${slugLike(base)}`);
    const llmCounts = history.snapshots.map((s) =>
      s.model.files.reduce((n, f) => n + f.annotations.filter((a) => a.kind === "llm").length, 0),
    );
    expect(llmCounts[0]).toBe(0); // older commit: notes overlay only
    expect(llmCounts[llmCounts.length - 1]).toBeGreaterThan(0); // tip: gap-filled
  }, 60_000);

  it("appends an event snapshot for pr-regen/pr-merge", async () => {
    const root = await tempRepo();
    const base = await commit(root, "a.ts", "export const a = 1;\n", "base");
    await commit(root, "a.ts", "export const a = 2;\n", "second");

    const res = await captureDocHistory(root, { base, event: "pr-regen", llmFill: false, ...FAST });
    expect(res.total).toBe(2); // one commit snapshot + one event snapshot
    const history = await loadDocHistory(root, `repo-${slugLike(base)}`);
    expect(history.snapshots.some((s) => s.event === "pr-regen")).toBe(true);
  }, 30_000);

  it("writes the scrubber HTML and tolerates a corrupt index line", async () => {
    const root = await tempRepo();
    const base = await commit(root, "a.ts", "export const a = 1;\n", "base");
    await commit(root, "a.ts", "export const a = 2;\n", "second");

    const res = await captureDocHistory(root, { base, llmFill: false, ...FAST });
    const html = await readFile(path.join(root, res.htmlPath), "utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('id="scrub"');

    // A garbage line in the index must be skipped, not throw.
    await appendFile(path.join(root, res.historyDir, "index.jsonl"), "not json\n");
    const history = await loadDocHistory(root, res.id);
    expect(history.snapshots.length).toBe(res.total);
  }, 30_000);
});

describe("doc-history schemas", () => {
  it("round-trips with defaults populated", () => {
    const snap = DocSnapshot.parse({
      event: "commit",
      captured_at: "2026-01-01T00:00:00.000Z",
      model: {
        kind: "repo",
        title: "t",
        generated_at: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(snap.schema_version).toBe(1);
    expect(snap.pr_comments).toEqual([]);
    expect(snap.labels).toEqual([]);

    const hist = DocHistory.parse({ id: "repo-x", kind: "repo", title: "t" });
    expect(hist.snapshots).toEqual([]);
    expect(hist.schema_version).toBe(1);
  });
});

// Mirrors doc_store's slug() for deriving the repo-<base> id in assertions.
function slugLike(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "head";
}
