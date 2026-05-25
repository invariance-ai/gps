import path from "node:path";
import type { Note, Question, SymbolRef, TestRef, Invariant } from "@invariance/gps-schemas";
import { diffSymbols } from "./diff_symbols.js";
import { gateChanged } from "./gate_stream.js";
import { open as openQuery } from "./query.js";
import { testsForSymbol } from "./tests.js";
import { loadNotes, loadFileNotes, loadAreaNotes, rankNotes } from "./notes.js";
import { loadQuestions } from "./questions.js";

export interface BriefInput {
  base?: string;
  /** Cap symbols processed (notes/tests/questions lookup). Default 20. */
  max_symbols?: number;
}

export interface BriefNoteEntry {
  scope: "symbol" | "file" | "area";
  target: string;
  notes: Note[];
}

export interface BriefSymbolEntry {
  symbol: SymbolRef;
  tests: TestRef[];
  questions: Question[];
}

export interface BriefResult {
  base: string;
  changed_files: string[];
  changed_symbols: SymbolRef[];
  invariants: {
    hits: ReturnType<typeof toGateHit>[];
    blocking_count: number;
  };
  notes: BriefNoteEntry[];
  per_symbol: BriefSymbolEntry[];
  untested_symbols: string[];
  truncated: boolean;
  /** True when at least one indexed source symbol changed. False when only config/docs/non-indexed files changed. */
  source_changes: boolean;
}

type GateHitShape = {
  invariant: Invariant;
  symbols: string[];
  files: string[];
  waived: boolean;
};

function toGateHit(h: GateHitShape): GateHitShape {
  return {
    invariant: h.invariant,
    symbols: h.symbols,
    files: h.files,
    waived: h.waived,
  };
}

/**
 * Pre-finalize briefing for the dirty diff. Composes diffSymbols + gateChanged
 * + notes (symbol/file/area) + per-symbol tests/questions. Designed to be the
 * last call an agent makes before declaring an edit done.
 *
 * Never throws on a missing index — returns whatever it can. Callers decide
 * how to surface a `blocking_count > 0`.
 */
export async function brief(root: string, input: BriefInput = {}): Promise<BriefResult> {
  const max = input.max_symbols ?? 20;
  const diff = await diffSymbols(root, input.base ?? "HEAD");
  const gate = await gateChanged(root, { base: input.base });

  const symbols = diff.symbols.slice(0, max);
  const truncated = diff.symbols.length > max;

  // Notes: per-symbol, per-file, per-area (unique dirs).
  const symbolNoteEntries: BriefNoteEntry[] = [];
  for (const s of symbols) {
    const ns = await loadNotes(root, s.qualified_name ?? s.name);
    if (ns.length > 0) {
      symbolNoteEntries.push({ scope: "symbol", target: s.qualified_name ?? s.name, notes: rankNotes(ns, 5) });
    }
  }
  const fileNoteEntries: BriefNoteEntry[] = [];
  for (const f of diff.files) {
    const ns = await loadFileNotes(root, f);
    if (ns.length > 0) {
      fileNoteEntries.push({ scope: "file", target: f, notes: rankNotes(ns, 5) });
    }
  }
  const areas = [...new Set(diff.files.map((f) => path.dirname(f)).filter((d) => d && d !== "."))];
  const areaNoteEntries: BriefNoteEntry[] = [];
  for (const a of areas) {
    const ns = await loadAreaNotes(root, a);
    if (ns.length > 0) {
      areaNoteEntries.push({ scope: "area", target: a, notes: rankNotes(ns, 5) });
    }
  }

  // Per-symbol tests + questions. testsForSymbol checks co-located and
  // name-containing test files — the same heuristic as `gps tests`.
  const per_symbol: BriefSymbolEntry[] = [];
  const untested_symbols: string[] = [];
  let ctx: Awaited<ReturnType<typeof openQuery>> | null = null;
  try {
    ctx = await openQuery(root);
  } catch {
    // no index — skip tests lookup
  }
  for (const s of symbols) {
    const id = s.qualified_name ?? s.name;
    let tests: TestRef[] = [];
    if (ctx) {
      try {
        tests = await testsForSymbol(s.name, s.file, root, ctx.index);
      } catch {
        /* skip */
      }
    }
    const qs = await loadQuestions(root, s.name);
    per_symbol.push({ symbol: s, tests, questions: qs });
    if (tests.length === 0) untested_symbols.push(id);
  }

  return {
    base: diff.base,
    changed_files: diff.files,
    changed_symbols: symbols,
    invariants: {
      hits: gate.hits.map(toGateHit),
      blocking_count: gate.blocking.length,
    },
    notes: [...symbolNoteEntries, ...fileNoteEntries, ...areaNoteEntries],
    per_symbol,
    untested_symbols,
    truncated,
    source_changes: symbols.length > 0,
  };
}

/** Render a brief as a human-readable markdown report. */
export function formatBriefMarkdown(b: BriefResult): string {
  const lines: string[] = [];

  // No indexed source symbols changed, but files did change (e.g. only .gps/,
  // docs, or other non-indexed files). Emit one explicit status line instead of
  // a wall of empty Invariants/Notes/Tests sections that reads like a clean pass.
  if (!b.source_changes && b.changed_files.length > 0) {
    return `No source-file changes detected (only config/docs/non-indexed files changed) — nothing to check. (${b.changed_files.length} file(s) changed vs ${b.base})\n`;
  }

  lines.push(`# Brief — ${b.changed_symbols.length} symbol(s) across ${b.changed_files.length} file(s) vs ${b.base}`);
  if (b.truncated) lines.push(`_(truncated to ${b.changed_symbols.length} symbols)_`);

  // Changed symbols (the headline content — what the agent touched).
  lines.push(`\n## Changed symbols`);
  if (b.changed_symbols.length === 0) {
    lines.push(`_no indexed symbols in diff (only untracked/non-code files?)_`);
  } else {
    for (const s of b.changed_symbols) {
      const name = s.qualified_name ?? s.name;
      lines.push(`- \`${name}\` (${s.kind}) — \`${s.file}:${s.line}\``);
    }
  }

  // Invariants
  lines.push(`\n## Invariants`);
  if (b.invariants.hits.length === 0) {
    lines.push(`_no invariant matches in touched symbols_`);
  } else {
    for (const h of b.invariants.hits) {
      const sev = h.invariant.severity;
      const tag = sev === "block" ? (h.waived ? "WAIVED" : "BLOCK") : sev === "warn" ? "WARN" : "INFO";
      lines.push(`- **${tag}** \`${h.invariant.name}\` — ${h.invariant.rule}`);
      if (h.symbols.length) lines.push(`  - symbols: ${h.symbols.join(", ")}`);
    }
    if (b.invariants.blocking_count > 0) {
      lines.push(`\n**${b.invariants.blocking_count} blocking** — resolve or waive before merge.`);
    }
  }

  // Notes
  lines.push(`\n## Notes`);
  if (b.notes.length === 0) {
    lines.push(`_no notes attached to changed symbols/files/areas_`);
  } else {
    for (const n of b.notes) {
      lines.push(`\n### ${n.scope}: \`${n.target}\``);
      for (const note of n.notes) {
        lines.push(`- (${note.severity}) ${note.lesson}${note.evidence ? `  — _${note.evidence}_` : ""}`);
      }
    }
  }

  // Tests
  lines.push(`\n## Tests`);
  if (b.per_symbol.length === 0) {
    lines.push(`_no indexed symbols in diff_`);
  } else {
    for (const e of b.per_symbol) {
      const name = e.symbol.qualified_name ?? e.symbol.name;
      if (e.tests.length === 0) {
        lines.push(`- ⚠️  \`${name}\` — **no tests found**`);
      } else {
        const files = e.tests.map((t) => t.file).slice(0, 5);
        lines.push(`- \`${name}\` → ${files.map((f) => `\`${f}\``).join(", ")}${e.tests.length > 5 ? ` (+${e.tests.length - 5})` : ""}`);
      }
    }
  }

  // Untested symbols — duplicate the warning explicitly so it's not buried in
  // the Tests list. Markdown is the surface most users (and LLMs) read first.
  if (b.untested_symbols.length > 0) {
    lines.push(`\n## ⚠️  Untested symbols`);
    lines.push(`${b.untested_symbols.length} changed symbol(s) have no detected tests:`);
    for (const id of b.untested_symbols) lines.push(`- \`${id}\``);
  }

  // Open questions
  const withQuestions = b.per_symbol.filter((e) => e.questions.length > 0);
  if (withQuestions.length > 0) {
    lines.push(`\n## Open questions`);
    for (const e of withQuestions) {
      const name = e.symbol.qualified_name ?? e.symbol.name;
      for (const q of e.questions) {
        lines.push(`- \`${name}\` — ${q.question}`);
      }
    }
  }

  return lines.join("\n") + "\n";
}
