import type {
  ContextResult,
  ImpactResult,
  Invariant,
  TestRef,
  ProvenanceEntry,
} from "@invariance/gps-schemas";

// Auto-strip ANSI when piped (agents shelling out via Bash) or NO_COLOR is set.
// Set GPS_FORCE_COLOR=1 to override.
const useColor =
  process.env.GPS_FORCE_COLOR === "1" ||
  (!process.env.NO_COLOR && !!process.stdout.isTTY);
const w = (code: string) => (s: string) =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const c = {
  bold: w("1"),
  dim: w("2"),
  red: w("31"),
  yellow: w("33"),
  green: w("32"),
  cyan: w("36"),
};

const riskColor: Record<string, (s: string) => string> = {
  high: c.red,
  medium: c.yellow,
  low: c.green,
};

export function formatContextMarkdown(r: ContextResult): string {
  const L: string[] = [];
  L.push(`# ${r.symbol.name}`);
  L.push("");
  L.push(`**Defined in:** \`${r.symbol.file}:${r.symbol.line}\` (${r.symbol.kind})`);
  L.push(`**Risk:** ${r.risk.toUpperCase()}`);
  L.push("");
  if (r.callers.length) {
    L.push("## Called by");
    for (const x of r.callers.slice(0, 10)) L.push(`- \`${x.name}\` — ${x.file}:${x.line}`);
    if (r.callers.length > 10) L.push(`- …and ${r.callers.length - 10} more`);
    L.push("");
  }
  if (r.callees.length) {
    L.push("## Calls");
    for (const x of r.callees.slice(0, 10)) L.push(`- \`${x.name}\` — ${x.file}:${x.line}`);
    L.push("");
  }
  if (r.tests.length) {
    L.push("## Tests");
    for (const t of r.tests) L.push(`- \`${t.file}\` (${t.framework})`);
    L.push("");
  }
  if (r.invariants.length) {
    L.push("## Invariants");
    for (const inv of r.invariants) {
      L.push(`- **${inv.name}** (${inv.severity}) — ${inv.rule}`);
      if (inv.evidence.length) L.push(`  - evidence: ${inv.evidence.join(", ")}`);
    }
    L.push("");
  }
  if (r.notes.length) {
    L.push("## Notes from previous edits");
    for (const n of r.notes) {
      L.push(`- **[${n.severity}]** ${n.lesson}`);
      if (n.evidence) L.push(`  - evidence: ${n.evidence}`);
    }
    L.push("");
  }
  if (r.decisions.length) {
    L.push("## Past decisions");
    for (const d of r.decisions) {
      L.push(`- **${d.decision}**`);
      if (d.rejected_alternative) L.push(`  - rejected: ${d.rejected_alternative}`);
      if (d.rationale) L.push(`  - rationale: ${d.rationale}`);
    }
    L.push("");
  }
  if (r.provenance.length) {
    L.push("## Recent changes");
    for (const p of r.provenance.slice(0, 5))
      L.push(`- \`${p.commit}\` ${p.date.slice(0, 10)} ${p.author}: ${p.message}`);
    L.push("");
  }
  return L.join("\n");
}

export function formatImpactMarkdown(r: ImpactResult): string {
  const L: string[] = [];
  L.push(`# Impact: ${r.symbol.name}`);
  L.push("");
  L.push(`**Blast radius:** ${r.blast_radius}`);
  L.push("");
  if (r.affected_symbols.length) {
    L.push("## Affected symbols");
    for (const s of r.affected_symbols) L.push(`- \`${s.name}\` — ${s.file}:${s.line}`);
    L.push("");
  }
  if (r.affected_files.length) {
    L.push("## Affected files");
    for (const f of r.affected_files) L.push(`- \`${f}\``);
    L.push("");
  }
  if (r.affected_tests.length) {
    L.push("## Tests to run");
    for (const t of r.affected_tests) L.push(`- \`${t.file}\` (${t.framework})`);
    L.push("");
  }
  return L.join("\n");
}

export function formatContextPretty(r: ContextResult): string {
  const L: string[] = [];
  L.push(c.bold(`Symbol:    ${r.symbol.name}`) + c.dim(`  (${r.symbol.kind})`));
  L.push(`Defined in: ${r.symbol.file}:${r.symbol.line}`);
  L.push(`Risk:      ${riskColor[r.risk]!(r.risk.toUpperCase())}`);
  L.push("");
  if (r.callers.length) {
    L.push(c.bold("Called by:"));
    for (const x of r.callers.slice(0, 10)) L.push(`  - ${x.name}  ${c.dim(`${x.file}:${x.line}`)}`);
    if (r.callers.length > 10) L.push(c.dim(`  …and ${r.callers.length - 10} more`));
    L.push("");
  }
  if (r.callees.length) {
    L.push(c.bold("Calls:"));
    for (const x of r.callees.slice(0, 10)) L.push(`  - ${x.name}  ${c.dim(`${x.file}:${x.line}`)}`);
    L.push("");
  }
  if (r.tests.length) {
    L.push(c.bold("Tests:"));
    for (const t of r.tests) L.push(`  - ${t.file}  ${c.dim(`(${t.framework})`)}`);
    L.push("");
  }
  if (r.invariants.length) {
    L.push(c.bold("Invariants:"));
    for (const inv of r.invariants) {
      L.push(`  - ${c.cyan(inv.name)} ${c.dim(`[${inv.severity}]`)}`);
      L.push(`    ${inv.rule}`);
      if (inv.evidence.length) L.push(c.dim(`    evidence: ${inv.evidence.join(", ")}`));
    }
    L.push("");
  }
  if (r.notes.length) {
    L.push(c.bold("Notes from previous edits:"));
    for (const n of r.notes) {
      L.push(`  - ${c.dim(`[${n.severity}]`)} ${n.lesson}`);
      if (n.evidence) L.push(c.dim(`    evidence: ${n.evidence}`));
    }
    L.push("");
  }
  if (r.decisions.length) {
    L.push(c.bold("Past decisions:"));
    for (const d of r.decisions) {
      L.push(`  - ${d.decision}`);
      if (d.rejected_alternative) L.push(c.dim(`    rejected: ${d.rejected_alternative}`));
      if (d.rationale) L.push(c.dim(`    rationale: ${d.rationale}`));
    }
    L.push("");
  }
  if (r.provenance.length) {
    L.push(c.bold("Recent changes:"));
    for (const p of r.provenance.slice(0, 5))
      L.push(`  - ${c.dim(p.commit)} ${p.date.slice(0, 10)} ${p.author}: ${p.message}`);
    L.push("");
  }
  return L.join("\n");
}

export function formatImpactPretty(r: ImpactResult): string {
  const L: string[] = [];
  L.push(c.bold(`Impact of ${r.symbol.name}`) + c.dim(`  (blast radius: ${r.blast_radius})`));
  L.push("");
  if (r.affected_symbols.length) {
    L.push(c.bold("Affected symbols:"));
    for (const s of r.affected_symbols) L.push(`  - ${s.name}  ${c.dim(`${s.file}:${s.line}`)}`);
    L.push("");
  }
  if (r.affected_files.length) {
    L.push(c.bold("Affected files:"));
    for (const f of r.affected_files) L.push(`  - ${f}`);
    L.push("");
  }
  if (r.affected_tests.length) {
    L.push(c.bold("Tests to run:"));
    for (const t of r.affected_tests) L.push(`  - ${t.file}  ${c.dim(`(${t.framework})`)}`);
    L.push("");
  }
  return L.join("\n");
}

export function formatInvariantsPretty(symbol: string, invs: Invariant[]): string {
  if (invs.length === 0) return c.dim(`No invariants apply to ${symbol}.`);
  const L: string[] = [c.bold(`Invariants for ${symbol}:`), ""];
  for (const inv of invs) {
    L.push(`  - ${c.cyan(inv.name)} ${c.dim(`[${inv.severity}]`)}`);
    L.push(`    ${inv.rule}`);
    if (inv.evidence.length) L.push(c.dim(`    evidence: ${inv.evidence.join(", ")}`));
  }
  return L.join("\n");
}

export function formatTestsPretty(symbol: string, tests: TestRef[]): string {
  if (tests.length === 0) return c.dim(`No tests found for ${symbol}.`);
  const L: string[] = [c.bold(`Tests for ${symbol}:`), ""];
  for (const t of tests) L.push(`  - ${t.file}  ${c.dim(`(${t.framework})`)}`);
  return L.join("\n");
}

export function formatTracePretty(symbol: string, p: ProvenanceEntry[]): string {
  if (p.length === 0) return c.dim(`No git history for ${symbol}.`);
  const L: string[] = [c.bold(`History for ${symbol}:`), ""];
  for (const e of p) L.push(`  ${c.dim(e.commit)} ${e.date.slice(0, 10)} ${e.author}: ${e.message}`);
  return L.join("\n");
}
