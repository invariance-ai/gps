import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  DocHistory,
  DocHistoryManifest,
  DocSnapshot,
  type DocHistory as DocHistoryT,
  type DocHistoryManifest as DocHistoryManifestT,
  type DocPrComment,
  type DocSnapshot as DocSnapshotT,
  type DocSnapshotEvent,
} from "@invariance/gps-schemas";
import { fetchPrThread, type PrThread } from "../gh.js";
import {
  commitsBetween,
  diffBetween,
  parentOf,
  type CommitMeta,
} from "../git_diff.js";
import { buildDocModelFromDiff, type AssembleMeta, type BuildDocOpts } from "./doc_model.js";
import { atomicWrite, slug } from "./doc_store.js";
import type { BrandPalette } from "./html_render.js";
import { renderHistoryHtml } from "./history_html_render.js";

/**
 * Doc *history*: an append-only, time-scrubbable record of a doc's life. Where
 * `doc_store` keeps only the latest doc per id (overwriting on regen), this
 * captures a snapshot of the full DocModel — code, annotations, PR comments and
 * labels — at each commit / PR-regen / PR-merge, so you can replay what the code
 * and its knowledge looked like at every point in time.
 *
 * Snapshots are built by diffing arbitrary commit pairs (`git diff A B`), which
 * is **read-only** — the user's working tree is never touched, even when they
 * have uncommitted work.
 *
 * On-disk layout, mirroring the append-only `features-history.jsonl` precedent:
 *
 *   <out_dir>/history/<id>/index.jsonl          one line per snapshot (the log)
 *   <out_dir>/history/<id>/snap-<key>.json      one full DocSnapshot, written once
 *   <out_dir>/history/<id>.html                 the self-contained scrubber doc
 *   <out_dir>/history/manifest.json             index of all histories
 */

export interface CaptureHistoryOpts extends BuildDocOpts {
  out_dir?: string;
  /** Base ref the commit walk starts from (exclusive), e.g. "origin/main". */
  base: string;
  /** Tip ref of the walk (default "HEAD"). */
  head?: string;
  /** PR number when documenting a PR — pulls comments + labels via `gh`. */
  pr?: number;
  /** Human PR title (for the history title); falls back to `PR #<n>`. */
  prTitle?: string;
  /** Tags the tip snapshot; "commit" (default) adds no extra event snapshot. */
  event?: DocSnapshotEvent;
  /** Keep full diff bodies for only the latest K snapshots (passed to renderer). */
  fullSnapshots?: number;
  brand?: BrandPalette;
}

export interface SnapshotResult {
  id: string;
  added: number;
  total: number;
  historyDir: string;
  htmlPath: string;
}

/** One line of `index.jsonl`: pointer + dedupe keys for a stored snapshot. */
interface IndexEntry {
  event: DocSnapshotEvent;
  captured_at: string;
  sha?: string;
  ref?: string;
  /** Snapshot filename within the history dir. */
  file: string;
}

function historyId(opts: { pr?: number; base: string }): string {
  return opts.pr ? `pr-${opts.pr}` : `repo-${slug(opts.base)}`;
}

function historyDirFor(root: string, outDir: string, id: string): string {
  return path.join(root, outDir, "history", id);
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? "").trim();
}

/** Filesystem-safe key for an event snapshot (no SHA to key on). */
function eventKey(event: DocSnapshotEvent, capturedAt: string): string {
  return `${event}-${capturedAt.replace(/[:.]/g, "-")}`;
}

function threadToComments(t: PrThread): DocPrComment[] {
  const out: DocPrComment[] = [];
  for (const r of t.reviews) {
    if (r.body.trim() || r.state) {
      out.push({ author: r.author, body: r.body, kind: "review", state: r.state });
    }
  }
  for (const c of t.comments) {
    if (c.body.trim()) out.push({ author: c.author, body: c.body, kind: "comment" });
  }
  return out;
}

/**
 * Load a doc history from disk. Tolerant like `loadManifest`: a missing dir or a
 * corrupt `index.jsonl` line is skipped rather than thrown. Snapshots are
 * returned oldest → newest.
 */
export async function loadDocHistory(
  root: string,
  id: string,
  outDir = ".gps/docs",
): Promise<DocHistoryT> {
  const dir = historyDirFor(root, outDir, id);
  const snapshots: DocSnapshotT[] = [];
  try {
    const raw = await readFile(path.join(dir, "index.jsonl"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as IndexEntry;
        const snapRaw = await readFile(path.join(dir, entry.file), "utf8");
        snapshots.push(DocSnapshot.parse(JSON.parse(snapRaw)));
      } catch {
        // Skip a malformed index line or unreadable/corrupt snapshot file.
      }
    }
  } catch {
    // No history yet — fall through to an empty record.
  }
  snapshots.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  const kind = id.startsWith("pr-") ? "pr" : "repo";
  const latest = snapshots[snapshots.length - 1];
  return DocHistory.parse({
    id,
    kind,
    title: latest?.model.pr?.title ?? latest?.model.title ?? id,
    pr_number: latest?.model.pr?.number,
    snapshots,
  });
}

function sortKey(s: DocSnapshotT): string {
  return s.commit?.date ?? s.captured_at;
}

/**
 * Walk `base..head`, snapshot the DocModel at each new commit, optionally append
 * a PR-regen/PR-merge event snapshot at the tip, then (re)render the scrubber
 * HTML over the full series. Idempotent: commits already captured (by SHA) are
 * skipped, so re-running adds only genuinely new commits.
 */
export async function captureDocHistory(
  root: string,
  opts: CaptureHistoryOpts,
): Promise<SnapshotResult> {
  const outDir = opts.out_dir ?? ".gps/docs";
  const id = historyId(opts);
  const dir = historyDirFor(root, outDir, id);
  const head = opts.head ?? "HEAD";
  const event = opts.event ?? "commit";

  const existing = await loadDocHistory(root, id, outDir);
  const seenShas = new Set(
    existing.snapshots.map((s) => s.sha).filter((s): s is string => !!s),
  );

  // PR context (comments + labels) — attached to the tip snapshot only, since
  // `gh` comments aren't addressable per historical commit.
  let prComments: DocPrComment[] = [];
  let prLabels: string[] = [];
  if (opts.pr) {
    const thread = await fetchPrThread(opts.pr);
    if (thread) {
      prComments = threadToComments(thread);
      prLabels = thread.labels;
    }
  }

  const commits = await commitsBetween(root, opts.base, head);
  const newCommits = commits.filter((c) => !seenShas.has(c.sha));

  // The "tip" snapshot carries LLM gap-fill (cost gate) + PR comments/labels.
  // When an explicit event is requested it owns the tip; otherwise the newest
  // new commit does.
  const isEvent = event === "pr-regen" || event === "pr-merge";
  const llmTipSha = isEvent ? null : newCommits[newCommits.length - 1]?.sha;

  await mkdir(dir, { recursive: true });
  const indexLines: string[] = [];
  let added = 0;

  for (const commit of newCommits) {
    const isLlmTip = commit.sha === llmTipSha;
    const snap = await buildCommitSnapshot(root, opts, commit, {
      llmFill: isLlmTip ? opts.llmFill : false,
      prComments: isLlmTip ? prComments : [],
      labels: isLlmTip ? prLabels : [],
    });
    const file = `snap-${commit.sha.slice(0, 7)}.json`;
    await atomicWrite(path.join(dir, file), JSON.stringify(snap, null, 2));
    indexLines.push(
      JSON.stringify({
        event: snap.event,
        captured_at: snap.captured_at,
        sha: snap.sha,
        ref: snap.ref,
        file,
      } satisfies IndexEntry),
    );
    added++;
  }

  if (isEvent) {
    const snap = await buildEventSnapshot(root, opts, event, {
      prComments,
      labels: prLabels,
      tipSha: commits[commits.length - 1]?.sha,
    });
    const file = `snap-${eventKey(event, snap.captured_at)}.json`;
    await atomicWrite(path.join(dir, file), JSON.stringify(snap, null, 2));
    indexLines.push(
      JSON.stringify({
        event: snap.event,
        captured_at: snap.captured_at,
        sha: snap.sha,
        ref: snap.ref,
        file,
      } satisfies IndexEntry),
    );
    added++;
  }

  if (indexLines.length) {
    await appendFile(path.join(dir, "index.jsonl"), indexLines.join("\n") + "\n");
  }

  // Render the scrubber over the full, freshly-reloaded series.
  const history = await loadDocHistory(root, id, outDir);
  const htmlAbs = path.join(root, outDir, "history", `${id}.html`);
  await atomicWrite(
    htmlAbs,
    renderHistoryHtml(history, { brand: opts.brand, fullSnapshots: opts.fullSnapshots }),
  );

  await upsertHistoryManifest(root, outDir, {
    id,
    kind: history.kind,
    title: history.title,
    html_path: path.relative(root, htmlAbs),
    snapshot_count: history.snapshots.length,
    updated_at: new Date().toISOString(),
    pr_number: history.pr_number,
  });

  return {
    id,
    added,
    total: history.snapshots.length,
    historyDir: path.relative(root, dir),
    htmlPath: path.relative(root, htmlAbs),
  };
}

function metaFor(
  opts: CaptureHistoryOpts,
  title: string,
  subtitle: string,
  narrative: string,
): AssembleMeta {
  if (opts.pr) {
    return {
      kind: "pr",
      title,
      subtitle,
      pr: { number: opts.pr, title: opts.prTitle ?? `PR #${opts.pr}`, body: narrative },
      narrative,
    };
  }
  return { kind: "repo", title, subtitle, base: opts.base, narrative };
}

async function buildCommitSnapshot(
  root: string,
  opts: CaptureHistoryOpts,
  commit: CommitMeta,
  extra: { llmFill?: boolean; prComments: DocPrComment[]; labels: string[] },
): Promise<DocSnapshotT> {
  const ref = commit.sha.slice(0, 7);
  const parent = await parentOf(root, commit.sha);
  const diff = await diffBetween(root, parent, commit.sha);
  const model = await buildDocModelFromDiff(
    root,
    diff,
    metaFor(opts, firstLine(commit.message) || ref, ref, commit.message),
    { annotate: opts.annotate, llmFill: extra.llmFill, maxDiffBytes: opts.maxDiffBytes },
  );
  return DocSnapshot.parse({
    sha: commit.sha,
    ref,
    event: "commit",
    captured_at: new Date().toISOString(),
    commit: { author: commit.author, date: commit.date, message: commit.message },
    model,
    pr_comments: extra.prComments,
    labels: extra.labels,
  });
}

async function buildEventSnapshot(
  root: string,
  opts: CaptureHistoryOpts,
  event: DocSnapshotEvent,
  extra: { prComments: DocPrComment[]; labels: string[]; tipSha?: string },
): Promise<DocSnapshotT> {
  const head = opts.head ?? "HEAD";
  const ref = extra.tipSha ? extra.tipSha.slice(0, 7) : head;
  // Cumulative diff base..head — the full state of the change at this moment.
  const diff = await diffBetween(root, opts.base, head);
  const title = opts.prTitle ?? (opts.pr ? `PR #${opts.pr}` : `${opts.base}..${head}`);
  const model = await buildDocModelFromDiff(
    root,
    diff,
    metaFor(opts, title, `${event} · ${ref}`, opts.prTitle ?? ""),
    { annotate: opts.annotate, llmFill: opts.llmFill, maxDiffBytes: opts.maxDiffBytes },
  );
  return DocSnapshot.parse({
    sha: extra.tipSha,
    ref,
    event,
    captured_at: new Date().toISOString(),
    model,
    pr_comments: extra.prComments,
    labels: extra.labels,
  });
}

export function historyManifestPath(root: string, outDir: string): string {
  return path.join(root, outDir, "history", "manifest.json");
}

export async function loadHistoryManifest(
  root: string,
  outDir: string,
): Promise<DocHistoryManifestT> {
  try {
    const raw = await readFile(historyManifestPath(root, outDir), "utf8");
    return DocHistoryManifest.parse(JSON.parse(raw));
  } catch {
    return DocHistoryManifest.parse({});
  }
}

async function upsertHistoryManifest(
  root: string,
  outDir: string,
  entry: DocHistoryManifestT["histories"][number],
): Promise<DocHistoryManifestT> {
  const manifest = await loadHistoryManifest(root, outDir);
  const next = manifest.histories.filter((h) => h.id !== entry.id);
  next.push(entry);
  next.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const updated = DocHistoryManifest.parse({ version: 1, histories: next });
  await atomicWrite(historyManifestPath(root, outDir), JSON.stringify(updated, null, 2));
  return updated;
}

/** List the snapshot files on disk for an id (debug / inspection aid). */
export async function listSnapshotFiles(
  root: string,
  id: string,
  outDir = ".gps/docs",
): Promise<string[]> {
  try {
    const files = await readdir(historyDirFor(root, outDir, id));
    return files.filter((f) => f.startsWith("snap-") && f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}
