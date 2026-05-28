import {
  DocModel,
  type DocModel as DocModelT,
  type DocAnnotation,
  type DocAnnotateRequest,
  type DocFileEntry,
  type DocSection,
  type DocStats,
} from "@invariance/gps-schemas";
import type { PrSnapshot } from "../gh.js";
import { diffText } from "../git_diff.js";
import { splitDiffByFile, type DiffFileSegment } from "./diff_split.js";
import { collectAnnotations } from "./doc_annotations.js";
import { languageForPath } from "./highlight.js";

/**
 * Assemble a DocModel from a diff. This is the only layer that does I/O
 * (git/notes/index/LLM); the renderers downstream are pure `DocModel -> string`.
 *
 * To keep `core` free of an `@invariance/gps-llm` dependency, the LLM gap-fill
 * is injected as a callback (`LlmAnnotator`). The CLI builds it from GpsLlm.
 */

/** Fills plain-english annotations for hunks that have no captured note. */
export type LlmAnnotator = (reqs: DocAnnotateRequest[]) => Promise<DocAnnotation[]>;

export interface BuildDocOpts {
  annotate?: LlmAnnotator;
  llmFill?: boolean;
  maxDiffBytes?: number;
  /** Per-file line cap; files with larger diffs render as truncated. */
  maxFileLines?: number;
}

const DEFAULT_MAX_DIFF = 1_500_000;
const DEFAULT_MAX_FILE_LINES = 3000;

export async function buildPrDocModel(
  root: string,
  pr: PrSnapshot,
  opts: BuildDocOpts = {},
): Promise<DocModelT> {
  return assemble(root, pr.diff, opts, {
    kind: "pr",
    title: pr.title || `PR #${pr.number}`,
    subtitle: `PR #${pr.number}`,
    pr: { number: pr.number, title: pr.title, body: pr.body },
    narrative: pr.body,
  });
}

export async function buildDiffDocModel(
  root: string,
  base: string,
  opts: BuildDocOpts = {},
): Promise<DocModelT> {
  const diff = await diffText(root, base);
  return assemble(root, diff, opts, {
    kind: "repo",
    title: `Working changes vs ${base}`,
    subtitle: `local diff · base ${base}`,
    base,
  });
}

interface AssembleMeta {
  kind: "pr" | "repo";
  title: string;
  subtitle?: string;
  base?: string;
  pr?: { number: number; title: string; body: string };
  narrative?: string;
}

async function assemble(
  root: string,
  diff: string,
  opts: BuildDocOpts,
  meta: AssembleMeta,
): Promise<DocModelT> {
  const maxDiff = opts.maxDiffBytes ?? DEFAULT_MAX_DIFF;
  const maxFileLines = opts.maxFileLines ?? DEFAULT_MAX_FILE_LINES;
  const overBudget = diff.length > maxDiff;

  const segments = splitDiffByFile(diff);

  // Annotation overlay + LLM gap-fill (skipped when over budget — we won't show
  // bodies anyway).
  const collected = overBudget
    ? { byFile: new Map<string, DocAnnotation[]>(), unanchored: [], gaps: [] }
    : await collectAnnotations(root, segments);

  if (!overBudget && opts.llmFill !== false && opts.annotate && collected.gaps.length) {
    try {
      const filled = await opts.annotate(collected.gaps);
      for (const a of filled) {
        const arr = collected.byFile.get(a.file) ?? [];
        arr.push(a);
        collected.byFile.set(a.file, arr);
      }
    } catch {
      // LLM failure must never block doc generation — notes overlay still stands.
    }
  }

  const files: DocFileEntry[] = segments.map((seg) => toFileEntry(seg, collected.byFile, overBudget, maxFileLines));
  const stats = computeStats(files, collected.gaps.length);

  const sections = buildSections(meta, files, stats, collected.unanchored);

  return DocModel.parse({
    schema_version: 1,
    kind: meta.kind,
    title: meta.title,
    subtitle: meta.subtitle,
    generated_at: new Date().toISOString(),
    base: meta.base,
    pr: meta.pr,
    stats,
    files,
    sections,
    annotations_unanchored: collected.unanchored,
  });
}

function toFileEntry(
  seg: DiffFileSegment,
  byFile: Map<string, DocAnnotation[]>,
  overBudget: boolean,
  maxFileLines: number,
): DocFileEntry {
  const lineCount = seg.diff.split("\n").length;
  const truncated = overBudget || lineCount > maxFileLines;
  return {
    path: seg.path,
    language: languageForPath(seg.path),
    status: seg.status,
    diff: truncated || seg.binary ? undefined : seg.diff,
    hunks: seg.hunks.map((h) => ({ file: h.file, start_line: h.start_line, end_line: h.end_line })),
    annotations: byFile.get(seg.path) ?? [],
    binary: seg.binary,
    truncated: truncated && !seg.binary,
  };
}

function buildSections(
  meta: AssembleMeta,
  files: DocFileEntry[],
  stats: DocStats,
  unanchored: DocAnnotation[],
): DocSection[] {
  const sections: DocSection[] = [];

  // PR/branch description as the lead narrative.
  if (meta.narrative && meta.narrative.trim()) {
    sections.push({
      id: "description",
      title: "Description",
      markdown: meta.narrative.trim(),
      kind: "narrative",
    });
  }

  sections.push({
    id: "review-brief",
    title: "Review brief",
    markdown: buildReviewBrief(files, stats, unanchored),
    kind: "narrative",
  });

  sections.push({
    id: "review-checklist",
    title: "Review checklist",
    markdown: buildReviewChecklist(files, stats),
    kind: "narrative",
  });

  const overview: string[] = [];
  overview.push(
    `${files.length} file${files.length === 1 ? "" : "s"} changed` +
      (stats.annotations ? ` · ${stats.annotations} annotation${stats.annotations === 1 ? "" : "s"}` : ""),
  );
  overview.push("");
  for (const f of files) {
    const c = f.annotations.length ? ` _(${f.annotations.length} note${f.annotations.length === 1 ? "" : "s"})_` : "";
    overview.push(`- **${f.status}** \`${f.path}\`${c}`);
  }
  sections.push({
    id: "overview",
    title: "What changed",
    markdown: overview.join("\n"),
    kind: "narrative",
  });

  return sections;
}

function computeStats(files: DocFileEntry[], unannotatedHunks: number): DocStats {
  const byStatus: Record<string, number> = {};
  let added = 0;
  let deleted = 0;
  let annotations = 0;
  let high = 0;
  let binary = 0;
  let truncated = 0;

  for (const f of files) {
    byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
    if (f.binary) binary++;
    if (f.truncated) truncated++;
    annotations += f.annotations.length;
    high += f.annotations.filter((a) => a.severity === "high").length;
    if (!f.diff) continue;
    for (const line of f.diff.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) deleted++;
    }
  }

  return {
    files_changed: files.length,
    added_lines: added,
    deleted_lines: deleted,
    annotations,
    high_severity_annotations: high,
    unannotated_hunks: unannotatedHunks,
    binary_files: binary,
    truncated_files: truncated,
    by_status: byStatus,
  };
}

function buildReviewBrief(
  files: DocFileEntry[],
  stats: DocStats,
  unanchored: DocAnnotation[],
): string {
  const status = Object.entries(stats.by_status)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  const L: string[] = [];
  L.push(
    `${stats.files_changed} file${stats.files_changed === 1 ? "" : "s"} changed` +
      ` (${status || "no file entries"}), ` +
      `+${stats.added_lines}/-${stats.deleted_lines}.`,
  );
  L.push("");
  L.push(`- Anchored GPS/LLM annotations: **${stats.annotations}**`);
  L.push(`- Hunks still needing reviewer interpretation: **${stats.unannotated_hunks}**`);
  if (stats.high_severity_annotations) L.push(`- High-severity memory surfaced: **${stats.high_severity_annotations}**`);
  if (stats.binary_files) L.push(`- Binary files not rendered: **${stats.binary_files}**`);
  if (stats.truncated_files) L.push(`- Large files omitted from body: **${stats.truncated_files}**`);
  if (unanchored.length) L.push(`- Related notes not anchored to changed lines: **${unanchored.length}**`);

  const notable = files
    .filter((f) => f.annotations.length || f.truncated || f.binary)
    .slice(0, 8)
    .map((f) => {
      const tags: string[] = [];
      if (f.annotations.length) tags.push(`${f.annotations.length} note${f.annotations.length === 1 ? "" : "s"}`);
      if (f.truncated) tags.push("diff omitted");
      if (f.binary) tags.push("binary");
      return `- \`${f.path}\` — ${tags.join(", ")}`;
    });
  if (notable.length) {
    L.push("");
    L.push("Reviewer focus:");
    L.push(...notable);
  }
  return L.join("\n");
}

function buildReviewChecklist(files: DocFileEntry[], stats: DocStats): string {
  const L: string[] = [];
  L.push("- [ ] Read every high-severity GPS memory before approving.");
  L.push("- [ ] Confirm each LLM annotation against the diff; treat it as a reading aid, not evidence.");

  const paths = files.map((f) => f.path.toLowerCase());
  const touchesTests = paths.some((p) => /(^|\/)(__tests__|test|tests|spec)\b|(\.test|\.spec)\./.test(p));
  const touchesRisk = paths.some((p) => /(auth|security|permission|policy|payment|billing|stripe|token|secret|pii|privacy)/.test(p));
  const touchesSchema = paths.some((p) => /(schema|migration|database|db|sql|prisma|drizzle)/.test(p));

  if (touchesRisk) L.push("- [ ] Validate auth/security/privacy/payment behavior with the owning test or manual check.");
  if (touchesSchema) L.push("- [ ] Check migration/schema compatibility and rollback behavior.");
  if (touchesTests) L.push("- [ ] Verify changed tests fail on the old behavior and pass with this diff.");
  else L.push("- [ ] Decide whether this change needs a new or updated test; no test files changed.");
  if (stats.unannotated_hunks) L.push("- [ ] Review unannotated hunks directly; GPS had no memory or gloss for them.");
  if (stats.truncated_files || stats.binary_files) L.push("- [ ] Inspect omitted large/binary files outside this doc.");

  return L.join("\n");
}
