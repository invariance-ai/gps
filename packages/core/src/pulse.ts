import type {
  Note,
  Decision,
  PulseFinding,
  PulseResult,
  PulseSeverity,
} from "@invariance/gps-schemas";
import { gate } from "./gate.js";
import { loadNotes, rankNotes } from "./notes.js";
import { loadDecisions } from "./decisions.js";
import { open, callersOf, resolveSymbol } from "./query.js";
import { testsForSymbol } from "./tests.js";

export interface PulseOptions {
  base?: string;
  files?: string[];
  /** Heuristic: notes older than this many days are flagged as stale when their file changed. */
  staleDays?: number;
}

const SEV_WEIGHT: Record<PulseSeverity, number> = {
  info: 0.0,
  low: 0.1,
  medium: 0.25,
  high: 0.5,
  block: 1.0,
};

/**
 * Compose a diff-time risk report. Pure reads — no side effects on .gps/.
 * Weighting is intentionally simple so the score is explainable on a PR.
 */
export async function pulse(root: string, opts: PulseOptions = {}): Promise<PulseResult> {
  const g = await gate(root, { base: opts.base, files: opts.files });

  const findings: PulseFinding[] = [];

  for (const hit of g.hits) {
    const sev: PulseSeverity =
      hit.invariant.severity === "block" && !hit.waived
        ? "block"
        : hit.invariant.severity === "warn"
          ? "high"
          : "low";
    findings.push({
      kind: "invariant_hit",
      severity: sev,
      symbol: hit.symbols[0],
      file: hit.files[0],
      message: hit.waived
        ? `[waived] ${hit.invariant.name}: ${hit.invariant.rule}`
        : `${hit.invariant.name}: ${hit.invariant.rule}`,
      evidence: hit.invariant.evidence?.[0],
    });
  }

  // Per-symbol checks: untested callers, ignored notes, contradicted decisions.
  let ctx: Awaited<ReturnType<typeof open>> | null = null;
  try {
    ctx = await open(root);
  } catch {
    /* no index — skip symbol-resolved findings */
  }

  if (ctx) {
    for (const symId of g.changed_symbols) {
      const sym = resolveSymbol(symId, ctx);
      if (!sym) continue;

      const callers = callersOf(sym, ctx);
      const tests = await testsForSymbol(sym.name, sym.file, root, ctx.index);
      if (callers.length > 0 && tests.length === 0) {
        findings.push({
          kind: "untested_caller",
          severity: callers.length >= 3 ? "high" : "medium",
          symbol: symId,
          file: sym.file,
          message: `${symId} has ${callers.length} caller(s) and no covering tests`,
        });
      }

      const notes = rankNotes(await loadNotes(root, symId), 10);
      for (const n of notes) {
        const confidence = n.confidence ?? (n.verified_by ? 1 : 0.6);
        const sev: PulseSeverity =
          n.severity === "high" ? "high" : n.severity === "medium" ? "medium" : "low";
        findings.push({
          kind: "note_ignored",
          severity: scaleSeverity(sev, confidence),
          symbol: symId,
          file: sym.file,
          message: n.lesson,
          evidence: n.evidence_link ?? n.evidence,
        });
      }

      const decisions = await loadDecisions(root, symId);
      for (const d of decisions.slice(0, 3)) {
        findings.push({
          kind: "decision_contradicted",
          severity: "low",
          symbol: symId,
          file: sym.file,
          message: `Prior decision: ${d.decision}${d.rejected_alternative ? ` (rejected: ${d.rejected_alternative})` : ""}`,
          evidence: d.evidence_link,
        });
      }
    }
  }

  const score = scoreFindings(findings);
  const band: PulseResult["risk_band"] =
    score >= 0.75 ? "block" : score >= 0.5 ? "high" : score >= 0.2 ? "medium" : "low";

  return {
    base: g.base,
    changed_files: g.changed_files,
    changed_symbols: g.changed_symbols,
    findings,
    risk_score: round(score),
    risk_band: band,
    markdown: renderMarkdown(g.base, g.changed_files, g.changed_symbols, findings, score, band),
  };
}

function scaleSeverity(s: PulseSeverity, confidence: number): PulseSeverity {
  if (confidence >= 0.8) return s;
  if (confidence < 0.4) return s === "high" ? "medium" : s === "medium" ? "low" : "info";
  return s;
}

function scoreFindings(findings: PulseFinding[]): number {
  if (findings.length === 0) return 0;
  // Use max-plus-dampened-rest so 1 block dominates but many smalls add up.
  let max = 0;
  let rest = 0;
  for (const f of findings) {
    const w = SEV_WEIGHT[f.severity];
    if (w > max) {
      rest += max;
      max = w;
    } else {
      rest += w;
    }
  }
  return Math.min(1, max + 0.05 * rest);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function renderMarkdown(
  base: string,
  files: string[],
  symbols: string[],
  findings: PulseFinding[],
  score: number,
  band: PulseResult["risk_band"],
): string {
  const emoji = band === "block" ? "🛑" : band === "high" ? "⚠️" : band === "medium" ? "🟡" : "🟢";
  const lines: string[] = [];
  lines.push(`# gps pulse ${emoji} risk=${round(score)} (${band})`);
  lines.push("");
  lines.push(`**Base:** \`${base}\``);
  lines.push(`**Changed files:** ${files.length} · **Changed symbols:** ${symbols.length}`);
  lines.push("");
  if (findings.length === 0) {
    lines.push("_No findings._");
    return lines.join("\n");
  }
  const groups: Record<string, PulseFinding[]> = {};
  for (const f of findings) {
    (groups[f.kind] ??= []).push(f);
  }
  const labels: Record<PulseFinding["kind"], string> = {
    invariant_hit: "Invariants",
    untested_caller: "Untested callers",
    note_ignored: "Notes attached to touched symbols",
    decision_contradicted: "Prior decisions to respect",
    stale_note: "Stale notes",
  };
  for (const k of Object.keys(groups) as Array<PulseFinding["kind"]>) {
    const items = groups[k];
    if (!items) continue;
    lines.push(`## ${labels[k]}`);
    for (const f of items) {
      const loc = f.symbol ? `\`${f.symbol}\`` : f.file ? `\`${f.file}\`` : "";
      const ev = f.evidence ? ` _(evidence: ${f.evidence})_` : "";
      lines.push(`- **[${f.severity}]** ${loc} ${f.message}${ev}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
