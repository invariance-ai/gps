import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import type { SeedProposal, SeedResult } from "@invariance/gps-schemas";
import { isGitRepo } from "./git.js";
import { extractTodos } from "./notes.js";

const execFile = promisify(_execFile);

export interface SeedOptions {
  maxCommits?: number;
  maxPrs?: number;
  /** Glob of files to scan for TODOs/FIXMEs. Empty disables. */
  scanFiles?: string[];
}

/** Tier definitions for `gps init --seed`. Exposed here so they can be
 * unit-tested without depending on the CLI package. The CLI re-exports
 * these for its own use. */
export type SeedTier = "safe" | "medium" | "aggressive";
export const SEED_TIERS: readonly SeedTier[] = ["safe", "medium", "aggressive"] as const;
export interface SeedTierConfig {
  maxCommits: number;
  maxPrs: number;
  minConfidence: number;
  sources: readonly SeedProposal["source"][];
}
export const SEED_TIER_DEFAULTS: Record<SeedTier, SeedTierConfig> = {
  safe:       { maxCommits: 0,   maxPrs: 0,   minConfidence: 0.6, sources: ["todo"] },
  medium:     { maxCommits: 100, maxPrs: 20,  minConfidence: 0.4, sources: ["todo", "git", "pr"] },
  aggressive: { maxCommits: 500, maxPrs: 100, minConfidence: 0.2, sources: ["todo", "git", "pr", "incident"] },
};

/**
 * Mine git history (+ gh PRs when available) for proposed notes/decisions/invariants.
 * Pure read; emits proposals only — writing to .gps/ is up to the caller.
 */
export async function seed(root: string, opts: SeedOptions = {}): Promise<SeedResult> {
  const proposals: SeedProposal[] = [];
  const maxCommits = opts.maxCommits ?? 200;
  const maxPrs = opts.maxPrs ?? 50;
  let commits = 0;
  let prs = 0;
  let todos = 0;

  if (await isGitRepo(root)) {
    const log = await gitLog(root, maxCommits);
    commits = log.length;
    for (const c of log) {
      const p = commitToProposal(c);
      if (p) proposals.push(p);
    }
    const prList = await ghPrList(root, maxPrs);
    prs = prList.length;
    for (const pr of prList) {
      const p = prToProposal(pr);
      if (p) proposals.push(p);
    }
  }

  // TODO/FIXME mining — re-use extractTodos heuristic. Expand globs first
  // so callers can pass patterns (e.g. ALL_SOURCE_GLOBS) rather than
  // pre-walked file lists.
  if (opts.scanFiles && opts.scanFiles.length > 0) {
    const isGlob = (s: string): boolean => /[*?[\]]/.test(s);
    const patterns = opts.scanFiles.filter(isGlob);
    const literals = opts.scanFiles.filter((s) => !isGlob(s));
    let files = literals;
    if (patterns.length > 0) {
      const matched = await fg(patterns, {
        cwd: root,
        absolute: false,
        ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/.gps/**"],
        followSymbolicLinks: false,
      });
      files = files.concat(matched);
    }
    for (const f of files) {
      try {
        const raw = await readFile(path.resolve(root, f), "utf8");
        const items = extractTodos(raw, f);
        for (const t of items) {
          proposals.push({
            kind: "note",
            symbol: t.symbol,
            applies_to: [t.symbol],
            text: t.lesson,
            evidence_link: t.evidence,
            source: "todo",
            confidence: 0.6,
          });
          todos++;
        }
      } catch {
        /* skip */
      }
    }
  }

  return { proposals: dedupe(proposals), scanned: { commits, prs, todos } };
}

interface CommitInfo {
  sha: string;
  subject: string;
  body: string;
}

async function gitLog(root: string, n: number): Promise<CommitInfo[]> {
  try {
    const sep = "";
    const fieldSep = "";
    const fmt = `%H${fieldSep}%s${fieldSep}%b${sep}`;
    const { stdout } = await execFile(
      "git",
      ["log", `-n${n}`, `--pretty=format:${fmt}`],
      { cwd: root, maxBuffer: 8 * 1024 * 1024 },
    );
    const out: CommitInfo[] = [];
    for (const block of stdout.split(sep)) {
      const t = block.trim();
      if (!t) continue;
      const parts = t.split(fieldSep);
      const sha = parts[0] ?? "";
      const subject = parts[1] ?? "";
      const body = parts[2] ?? "";
      out.push({ sha, subject, body });
    }
    return out;
  } catch {
    return [];
  }
}

const FIX_RE = /^(?:fix|bug|hotfix|revert|patch)\b/i;
const DECISION_RE = /\b(?:chose|chosen|decided|prefer|over|instead of|rejected)\b/i;
// Conventional Commits prefix: `type(scope): subject` or `type!: subject`.
// We use the scope (when present) as a feature/area hint on applies_to so
// reviewers can route the proposal to the right slice of the repo.
const CONVENTIONAL_RE = /^([a-z]+)(?:\(([^)]+)\))?!?:\s*(.*)$/i;

function commitToProposal(c: CommitInfo): SeedProposal | null {
  const conv = CONVENTIONAL_RE.exec(c.subject);
  const scope = conv?.[2]?.trim();
  const appliesTo = scope ? [scope] : [];
  if (FIX_RE.test(c.subject)) {
    return {
      kind: "note",
      applies_to: appliesTo,
      text: c.subject,
      evidence_link: c.sha,
      source: "git",
      confidence: scope ? 0.5 : 0.4,
    };
  }
  if (DECISION_RE.test(c.subject) || DECISION_RE.test(c.body)) {
    return {
      kind: "decision",
      applies_to: appliesTo,
      text: c.subject,
      evidence_link: c.sha,
      source: "git",
      confidence: scope ? 0.6 : 0.5,
    };
  }
  return null;
}

interface PrInfo {
  number: number;
  title: string;
  body: string;
}

async function ghPrList(root: string, n: number): Promise<PrInfo[]> {
  try {
    const { stdout } = await execFile(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "merged",
        "--limit",
        String(n),
        "--json",
        "number,title,body",
      ],
      { cwd: root, maxBuffer: 16 * 1024 * 1024 },
    );
    const data = JSON.parse(stdout) as PrInfo[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function prToProposal(pr: PrInfo): SeedProposal | null {
  const text = `${pr.title}\n${pr.body ?? ""}`;
  if (FIX_RE.test(pr.title)) {
    return {
      kind: "note",
      applies_to: [],
      text: pr.title,
      evidence_link: `PR-${pr.number}`,
      source: "pr",
      confidence: 0.55,
    };
  }
  if (DECISION_RE.test(text)) {
    return {
      kind: "decision",
      applies_to: [],
      text: pr.title,
      evidence_link: `PR-${pr.number}`,
      source: "pr",
      confidence: 0.6,
    };
  }
  return null;
}

function dedupe(ps: SeedProposal[]): SeedProposal[] {
  const seen = new Set<string>();
  const out: SeedProposal[] = [];
  for (const p of ps) {
    const k = `${p.kind}::${p.text.slice(0, 120)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}
