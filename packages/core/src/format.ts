import type {
  ContextResult,
  ImpactResult,
  Invariant,
  TestRef,
  ProvenanceEntry,
  ResolvePacketResult,
} from "@invariance/gps-schemas";
import { packByBudget, type PackSection } from "./budget.js";

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
  // Resolution confidence (Fix 2): rendered even though caller/test sections are
  // hidden when empty — a disconnected resolution is exactly what we must flag.
  if (r.resolution_warnings && r.resolution_warnings.length) {
    for (const wmsg of r.resolution_warnings) L.push(`> ⚠️ ${wmsg}`);
    L.push("");
  }
  if (r.did_you_mean && r.did_you_mean.length) {
    L.push("## You might mean");
    for (const d of r.did_you_mean) L.push(`- \`${d.symbol}\` — ${d.reason}`);
    L.push("");
  }
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
  if (r.resolution_warnings && r.resolution_warnings.length) {
    for (const wmsg of r.resolution_warnings) L.push(c.yellow(`! ${wmsg}`));
    L.push("");
  }
  if (r.did_you_mean && r.did_you_mean.length) {
    L.push(c.bold("You might mean:"));
    for (const d of r.did_you_mean) L.push(`  - ${c.cyan(d.symbol)}  ${c.dim(d.reason)}`);
    L.push("");
  }
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

function targetHeadline(r: ResolvePacketResult): string {
  const t = r.target;
  const label =
    t.kind === "diff" ? "working-tree diff" :
    t.kind === "pr" ? `PR #${t.value}` :
    t.kind === "commit" ? `commit ${t.value}` :
    `${t.kind} ${t.value}`;
  return label;
}

/**
 * Render a resolve packet as budgeted markdown for piping into an agent.
 * Sections are emitted in priority order (blocking invariants and tests first)
 * and packed by `packByBudget`; sections dropped for budget are listed in a
 * trailing `Truncated` note. budget <= 0 = unlimited.
 */
export function formatResolveMarkdown(r: ResolvePacketResult, budget = 0): string {
  const head = [
    `# Resolve: ${targetHeadline(r)}`,
    "",
    `**Blast radius:** ${r.blast_radius} symbol(s)` +
      (r.seeds.length ? ` · **Seeds:** ${r.seeds.map((s) => s.name).join(", ")}` : ""),
    "",
  ].join("\n");

  const sections: PackSection[] = [];

  const blocking = r.invariants.filter((i) => i.invariant.severity === "block");
  const otherInv = r.invariants.filter((i) => i.invariant.severity !== "block");
  if (blocking.length) {
    sections.push({
      heading: "## Blocking invariants (MUST respect)",
      items: blocking.map((i) => `- **${i.invariant.name}** [${i.relation}] — ${i.invariant.rule}`),
    });
  }
  sections.push({
    heading: "## Tests to run",
    items: r.affected_tests.map((t) => `- \`${t.file}\` (${t.framework})`),
  });
  sections.push({
    heading: "## Affected symbols",
    items: r.affected_symbols.map((s) => `- \`${s.name}\` — ${s.file}:${s.line}`),
  });
  sections.push({
    heading: "## Affected files",
    items: r.affected_files.map((f) => `- \`${f}\``),
  });
  if (otherInv.length) {
    sections.push({
      heading: "## Other invariants",
      items: otherInv.map((i) => `- ${i.invariant.name} [${i.invariant.severity}, ${i.relation}] — ${i.invariant.rule}`),
    });
  }
  sections.push({
    heading: "## Past decisions",
    items: r.decisions.map((d) =>
      `- ${d.decision}` + (d.rejected_alternative ? ` (rejected: ${d.rejected_alternative})` : ""),
    ),
  });
  sections.push({
    heading: "## Notes from previous edits",
    items: r.notes.map((n) => `- [${n.severity}] ${n.lesson}`),
  });
  sections.push({
    heading: "## Dependencies (callees)",
    items: r.dependencies.map((s) => `- \`${s.name}\` — ${s.file}:${s.line}`),
  });
  if (r.pr) {
    sections.push({
      heading: `## PR #${r.pr.number} review`,
      items: [
        ...r.pr.reviews.map((rv) => `- ${rv.author} (${rv.state}): ${rv.body}`.trim()),
        ...r.pr.comments.map((cm) => `- ${cm.author}: ${cm.body}`),
      ].filter((s) => s.length > 4),
    });
  }
  sections.push({
    heading: "## Recent changes",
    items: r.git_history.flatMap((g) =>
      g.commits.slice(0, 3).map((cm) => `- \`${g.file}\` ${cm.commit} ${cm.date.slice(0, 10)} ${cm.author}: ${cm.message}`),
    ),
  });
  sections.push({
    heading: "## Related repo memory",
    items: r.recall.map((h) => `- [${h.kind}] ${h.text}`),
  });
  if (r.prepare_markdown) {
    sections.push({ heading: "## Prepare brief", items: [], trailing: r.prepare_markdown });
  }

  const packed = packByBudget(sections, budget);
  const droppedForBudget = packed.dropped
    .filter((d) => d.reason === "budget")
    .map((d) => d.section.replace(/^##\s*/, ""));
  const out = [head, packed.text];
  if (droppedForBudget.length) {
    out.push("", `> Truncated (budget): ${[...new Set(droppedForBudget)].join(", ")}`);
  }
  return out.join("\n").trimEnd() + "\n";
}

/** Terminal-colored resolve packet (blocking invariants in red, tests in bold). */
export function formatResolvePretty(r: ResolvePacketResult): string {
  const L: string[] = [];
  L.push(c.bold(`Resolve ${targetHeadline(r)}`) + c.dim(`  (blast radius: ${r.blast_radius})`));
  if (r.seeds.length) L.push(c.dim(`seeds: ${r.seeds.map((s) => s.name).join(", ")}`));
  L.push("");

  const blocking = r.invariants.filter((i) => i.invariant.severity === "block");
  if (blocking.length) {
    L.push(c.red(c.bold("Blocking invariants (MUST respect):")));
    for (const i of blocking) {
      L.push(c.red(`  - ${i.invariant.name} [${i.relation}]`));
      L.push(`    ${i.invariant.rule}`);
    }
    L.push("");
  }
  if (r.affected_tests.length) {
    L.push(c.bold("Tests to run:"));
    for (const t of r.affected_tests) L.push(`  - ${t.file}  ${c.dim(`(${t.framework})`)}`);
    L.push("");
  }
  if (r.affected_symbols.length) {
    L.push(c.bold("Affected symbols:"));
    for (const s of r.affected_symbols.slice(0, 15)) L.push(`  - ${s.name}  ${c.dim(`${s.file}:${s.line}`)}`);
    if (r.affected_symbols.length > 15) L.push(c.dim(`  …and ${r.affected_symbols.length - 15} more`));
    L.push("");
  }
  const otherInv = r.invariants.filter((i) => i.invariant.severity !== "block");
  if (otherInv.length) {
    L.push(c.bold("Other invariants:"));
    for (const i of otherInv) L.push(`  - ${c.cyan(i.invariant.name)} ${c.dim(`[${i.invariant.severity}, ${i.relation}]`)}`);
    L.push("");
  }
  if (r.decisions.length) {
    L.push(c.bold("Past decisions:"));
    for (const d of r.decisions) L.push(`  - ${d.decision}`);
    L.push("");
  }
  if (r.notes.length) {
    L.push(c.bold("Notes from previous edits:"));
    for (const n of r.notes.slice(0, 8)) L.push(`  - ${c.dim(`[${n.severity}]`)} ${n.lesson}`);
    L.push("");
  }
  if (r.pr) {
    L.push(c.bold(`PR #${r.pr.number} review:`));
    for (const rv of r.pr.reviews) L.push(`  - ${rv.author} (${rv.state}): ${c.dim(rv.body.slice(0, 120))}`);
    for (const cm of r.pr.comments.slice(0, 5)) L.push(`  - ${cm.author}: ${c.dim(cm.body.slice(0, 120))}`);
    L.push("");
  }
  if (r.git_history.length) {
    L.push(c.bold("Recent changes:"));
    for (const g of r.git_history.slice(0, 8)) {
      const top = g.commits[0];
      if (top) L.push(`  - ${c.dim(`${g.file}`)} ${top.commit} ${top.date.slice(0, 10)} ${top.author}: ${top.message}`);
    }
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
