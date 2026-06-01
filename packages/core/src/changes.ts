import type { SymbolRef } from "@invariance/gps-schemas";
import { diffSymbols, symbolsForDiff } from "./diff_symbols.js";
import { parseUnifiedDiff } from "./diff_to_symbols.js";
import { fetchPr, type PrSnapshot } from "./gh.js";
import { commitsBetween, type CommitMeta } from "./git_diff.js";
import { readIndex } from "./index_store.js";

export interface ChangeCommit {
  sha: string;
  author: string;
  date: string;
  message: string;
  pr?: number;
}

export interface ChangeFileEntry {
  file: string;
  symbols: SymbolRef[];
}

export interface ChangeSummary {
  base: string;
  source: "diff" | "pr";
  pr?: {
    number: number;
    title: string;
    body: string;
  };
  changed_files: string[];
  changed_symbols: SymbolRef[];
  files: ChangeFileEntry[];
  commits: ChangeCommit[];
  prs: number[];
}

export interface ChangeSummaryInput {
  base?: string;
  head?: string;
  pr?: number | string;
  max_commits?: number;
}

export async function changeSummary(root: string, input: ChangeSummaryInput = {}): Promise<ChangeSummary> {
  if (input.pr !== undefined) return changeSummaryForPr(root, input.pr);
  const base = input.base ?? "HEAD";
  const diff = await diffSymbols(root, base);
  const commits = (await commitsBetween(root, base, input.head ?? "HEAD"))
    .slice(-(input.max_commits ?? 20))
    .map(toChangeCommit);
  const symbolsByFile = new Map<string, SymbolRef[]>();
  for (const s of diff.symbols) {
    const arr = symbolsByFile.get(s.file) ?? [];
    arr.push(s);
    symbolsByFile.set(s.file, arr);
  }

  const prs = [...new Set(commits.map((c) => c.pr).filter((n): n is number => typeof n === "number"))].sort(
    (a, b) => a - b,
  );

  return {
    base: diff.base,
    source: "diff",
    changed_files: diff.files,
    changed_symbols: diff.symbols,
    files: diff.files.map((file) => ({ file, symbols: symbolsByFile.get(file) ?? [] })),
    commits,
    prs,
  };
}

export async function changeSummaryForPr(root: string, pr: number | string): Promise<ChangeSummary> {
  const snapshot = await fetchPr(pr);
  if (!snapshot) throw new Error(`failed to fetch PR #${pr} via gh`);
  const symbols = await symbolsForPrSnapshot(root, snapshot);
  const symbolsByFile = new Map<string, SymbolRef[]>();
  for (const s of symbols) {
    const arr = symbolsByFile.get(s.file) ?? [];
    arr.push(s);
    symbolsByFile.set(s.file, arr);
  }

  return {
    base: `PR-${snapshot.number}`,
    source: "pr",
    pr: {
      number: snapshot.number,
      title: snapshot.title,
      body: snapshot.body,
    },
    changed_files: snapshot.files,
    changed_symbols: symbols,
    files: snapshot.files.map((file) => ({ file, symbols: symbolsByFile.get(file) ?? [] })),
    commits: [],
    prs: [snapshot.number],
  };
}

export async function symbolsForPrSnapshot(root: string, snapshot: PrSnapshot): Promise<SymbolRef[]> {
  try {
    const index = await readIndex(root);
    const hunks = parseUnifiedDiff(snapshot.diff);
    return symbolsForDiff(index, snapshot.files, hunks);
  } catch {
    return [];
  }
}

export function formatChangeSummaryMarkdown(summary: ChangeSummary): string {
  const lines: string[] = [];
  lines.push(summary.source === "pr" && summary.pr ? `# Changes for PR #${summary.pr.number}` : `# Changes vs ${summary.base}`);
  lines.push("");
  if (summary.pr) {
    lines.push(`**${summary.pr.title}**`);
    lines.push("");
  }
  lines.push(`- ${summary.changed_files.length} file(s) changed`);
  lines.push(`- ${summary.changed_symbols.length} indexed symbol(s) touched`);
  if (summary.prs.length > 0) lines.push(`- PR references: ${summary.prs.map((n) => `#${n}`).join(", ")}`);

  lines.push("");
  lines.push("## Files");
  if (summary.files.length === 0) {
    lines.push("_no changed files_");
  } else {
    for (const f of summary.files) {
      const symbols = f.symbols.map((s) => s.qualified_name ?? s.name);
      lines.push(`- \`${f.file}\`${symbols.length ? ` — ${symbols.map((s) => `\`${s}\``).join(", ")}` : ""}`);
    }
  }

  lines.push("");
  lines.push("## Commits");
  if (summary.commits.length === 0) {
    lines.push("_no commits found in this range; this may be a working-tree diff_");
  } else {
    for (const c of summary.commits) {
      const pr = c.pr ? ` (#${c.pr})` : "";
      lines.push(`- \`${c.sha.slice(0, 7)}\`${pr} ${c.message}`);
    }
  }

  return lines.join("\n") + "\n";
}

function toChangeCommit(c: CommitMeta): ChangeCommit {
  return {
    sha: c.sha,
    author: c.author,
    date: c.date,
    message: c.message,
    pr: prNumberFromMessage(c.message),
  };
}

export function prNumberFromMessage(message: string): number | undefined {
  const match = message.match(/\(#(\d+)\)|\bPR\s*#?(\d+)\b/i);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
