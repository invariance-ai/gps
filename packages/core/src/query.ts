import type {
  ContextResult,
  ImpactResult,
  Invariant,
  SymbolRef,
  TestRef,
  GetContextInput,
  ImpactInput,
  PrepareEditInput,
  PrepareEditResult,
} from "@invariance/gps-schemas";
import { readIndex, type GpsIndex } from "./index_store.js";
import { loadInvariants, invariantsFor } from "./invariants.js";
import { testsForSymbol, testFilesIn, frameworkFor } from "./tests.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { logForFile, churn, isGitRepo } from "./git.js";
import { loadNotes, rankNotes } from "./notes.js";
import { loadDecisions, rankDecisions } from "./decisions.js";
import { loadQuestions, filterByStatus } from "./questions.js";
import { packByBudget, type PackSection } from "./budget.js";
import { parseSince, isAfter } from "./time.js";
import { neighborhood, type NeighborEntry } from "./neighborhood.js";
import { classifyIntent, excludeForIntent } from "./intent.js";
import { loadAssumptions } from "./assumptions.js";
import { gapsForSymbol, type TestGap } from "./testgaps.js";
import { loadPreferences, rankPreferences } from "./preferences.js";
import { listTodos } from "./todos.js";
import type { Assumption, Question, Decision, Note, TodoItem } from "@invariance/gps-schemas";
import { PREPARE_EDIT_SCHEMA_VERSION } from "@invariance/gps-schemas";

interface ContextCaps {
  callers: number;
  callees: number;
  notes: number;
  decisions: number;
  preferences: number;
  provenance: number;
  todos: number;
}

const BRIEF_CAPS: ContextCaps = {
  callers: 5,
  callees: 5,
  notes: 1,
  decisions: 1,
  preferences: 1,
  provenance: 0,
  todos: 3,
};

const FULL_CAPS: ContextCaps = {
  callers: 25,
  callees: 25,
  notes: 5,
  decisions: 3,
  preferences: 5,
  provenance: 5,
  todos: 10,
};

const TRIM_ORDER: Array<keyof Omit<ContextResult, "symbol" | "risk" | "truncated">> = [
  "tests",
  "provenance",
  "preferences",
  "todos",
  "notes",
  "decisions",
  "callees",
  "callers",
  "invariants",
];

function trimToBudget(result: ContextResult, budgetTokens: number): ContextResult {
  if (!budgetTokens || budgetTokens <= 0) return result;
  const charBudget = budgetTokens * 4;
  const droppedSections = new Set<string>();
  let droppedCount = 0;
  let serialized = JSON.stringify(result);
  for (const key of TRIM_ORDER) {
    if (serialized.length <= charBudget) break;
    const arr = (result as unknown as Record<string, unknown[]>)[key];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    while (arr.length > 0 && serialized.length > charBudget) {
      arr.pop();
      droppedCount += 1;
      droppedSections.add(key);
      serialized = JSON.stringify(result);
    }
  }
  if (droppedCount > 0) {
    result.truncated = { sections: [...droppedSections], droppedCount };
  }
  return result;
}

interface IndexLookups {
  byId: Map<string, SymbolRef>;
  byQualified: Map<string, SymbolRef>;
  byName: Map<string, SymbolRef[]>;
  byNameLower: Map<string, SymbolRef>;
  callers: Map<string, string[]>; // sym key -> from keys
  callees: Map<string, string[]>; // sym key -> to keys
}

export interface QueryContext {
  root: string;
  index: GpsIndex;
  invariants: Invariant[];
  _lookups?: IndexLookups;
}

function symKey(s: SymbolRef): string {
  return s.id ?? s.qualified_name ?? s.name;
}

function buildLookups(index: GpsIndex): IndexLookups {
  const byId = new Map<string, SymbolRef>();
  const byQualified = new Map<string, SymbolRef>();
  const byName = new Map<string, SymbolRef[]>();
  const byNameLower = new Map<string, SymbolRef>();
  for (const s of index.symbols) {
    if (s.id) byId.set(s.id, s);
    if (s.qualified_name && !byQualified.has(s.qualified_name)) byQualified.set(s.qualified_name, s);
    const list = byName.get(s.name);
    if (list) list.push(s);
    else byName.set(s.name, [s]);
    const lower = s.name.toLowerCase();
    if (!byNameLower.has(lower)) byNameLower.set(lower, s);
    if (s.qualified_name) {
      const qlower = s.qualified_name.toLowerCase();
      if (!byNameLower.has(qlower)) byNameLower.set(qlower, s);
    }
  }
  const callers = new Map<string, string[]>();
  const callees = new Map<string, string[]>();
  for (const e of index.edges) {
    const from = e.from_id ?? e.from;
    const to = e.to_id ?? e.to;
    const list1 = callers.get(to);
    if (list1) list1.push(from);
    else callers.set(to, [from]);
    const list2 = callees.get(from);
    if (list2) list2.push(to);
    else callees.set(from, [to]);
  }
  return { byId, byQualified, byName, byNameLower, callers, callees };
}

function lookups(ctx: QueryContext): IndexLookups {
  if (!ctx._lookups) ctx._lookups = buildLookups(ctx.index);
  return ctx._lookups;
}

export async function open(root: string): Promise<QueryContext> {
  const index = await readIndex(root);
  const invariants = await loadInvariants(root);
  return { root, index, invariants };
}

export function resolveSymbol(query: string, ctx: QueryContext): SymbolRef | null {
  const L = lookups(ctx);
  const byId = L.byId.get(query);
  if (byId) return byId;
  const byQualified = L.byQualified.get(query);
  if (byQualified) return byQualified;
  const byNameList = L.byName.get(query);
  const first = byNameList?.[0];
  if (first) return first;
  return L.byNameLower.get(query.toLowerCase()) ?? null;
}

function resolveByKey(key: string, L: IndexLookups): SymbolRef | undefined {
  return L.byId.get(key) ?? L.byQualified.get(key) ?? L.byName.get(key)?.[0];
}

export function callersOf(symbol: SymbolRef | string, ctx: QueryContext): SymbolRef[] {
  const L = lookups(ctx);
  const sym = typeof symbol === "string" ? resolveSymbol(symbol, ctx) : symbol;
  if (!sym) return [];
  const keys: string[] = [];
  if (sym.id) keys.push(sym.id);
  const qn = sym.qualified_name ?? sym.name;
  if (qn !== sym.id) keys.push(qn);
  const seen = new Set<string>();
  const out: SymbolRef[] = [];
  for (const key of keys) {
    const list = L.callers.get(key);
    if (!list) continue;
    for (const k of list) {
      if (seen.has(k)) continue;
      seen.add(k);
      const r = resolveByKey(k, L);
      if (r) out.push(r);
    }
  }
  return out;
}

export function calleesOf(symbol: SymbolRef | string, ctx: QueryContext): SymbolRef[] {
  const L = lookups(ctx);
  const sym = typeof symbol === "string" ? resolveSymbol(symbol, ctx) : symbol;
  if (!sym) return [];
  const keys: string[] = [];
  if (sym.id) keys.push(sym.id);
  const qn = sym.qualified_name ?? sym.name;
  if (qn !== sym.id) keys.push(qn);
  const seen = new Set<string>();
  const out: SymbolRef[] = [];
  for (const key of keys) {
    const list = L.callees.get(key);
    if (!list) continue;
    for (const k of list) {
      if (seen.has(k)) continue;
      seen.add(k);
      const r = resolveByKey(k, L);
      if (r) out.push(r);
    }
  }
  return out;
}

export async function getContext(
  args: GetContextInput,
  ctxOrRoot: QueryContext | string,
): Promise<ContextResult> {
  const ctx = typeof ctxOrRoot === "string" ? await open(ctxOrRoot) : ctxOrRoot;
  const sym = resolveSymbol(args.symbol, ctx);
  if (!sym) throw new Error(`symbol not found: ${args.symbol}`);

  const mode = args.mode ?? "brief";
  const caps = mode === "full" ? FULL_CAPS : BRIEF_CAPS;
  const wants = new Set(args.strands);

  const callers = wants.has("structural") ? callersOf(sym, ctx).slice(0, caps.callers) : [];
  const callees = wants.has("structural") ? calleesOf(sym, ctx).slice(0, caps.callees) : [];
  const tests = wants.has("tests") ? await testsForSymbol(sym.name, sym.file, ctx.root, ctx.index) : [];
  let provenance: Awaited<ReturnType<typeof logForFile>> = [];
  if (caps.provenance > 0 && wants.has("provenance") && (await isGitRepo(ctx.root))) {
    provenance = await logForFile(ctx.root, sym.file, 20);
    if (args.since) {
      const since = parseSince(args.since);
      provenance = provenance.filter((p) => isAfter(p.date, since));
    }
    if (args.authored_by) {
      provenance = provenance.filter((p) => p.author === args.authored_by);
    }
    provenance = provenance.slice(0, caps.provenance);
  }
  const invariants = wants.has("invariants")
    ? invariantsFor(sym.qualified_name ?? sym.name, ctx.invariants)
    : [];
  const notesAll = await loadNotes(ctx.root, sym.name);
  const decisionsAll = await loadDecisions(ctx.root, sym.name);
  const since = args.since ? parseSince(args.since) : undefined;
  const notesFiltered = since
    ? notesAll.filter((n) => isAfter(n.recorded_at, since))
    : notesAll;
  let decisionsFiltered = since
    ? decisionsAll.filter((d) => isAfter(d.recorded_at, since))
    : decisionsAll;
  if (args.authored_by) {
    decisionsFiltered = decisionsFiltered.filter((d) => d.made_by === args.authored_by);
  }
  const notes = rankNotes(notesFiltered, caps.notes);
  const decisions = rankDecisions(decisionsFiltered, caps.decisions);
  const prefsAll = await loadPreferences(ctx.root);
  const preferences = rankPreferences(prefsAll, sym.name, sym.file, caps.preferences);

  const todosAll = await listTodos(ctx.root, { file: sym.file, symbol: sym.name });
  const todos: TodoItem[] = todosAll.filter((t) => !t.resolved_at).slice(0, caps.todos);

  const risk = computeRisk({ callers, tests, invariants, churn: await safeChurn(ctx.root, sym.file) });

  const result: ContextResult = {
    symbol: sym,
    callers,
    callees,
    tests,
    provenance,
    invariants,
    notes,
    decisions,
    preferences,
    risk,
    todos,
  };
  return trimToBudget(result, args.budget ?? 1500);
}

export async function impactOf(
  args: ImpactInput,
  ctxOrRoot: QueryContext | string,
): Promise<ImpactResult> {
  const ctx = typeof ctxOrRoot === "string" ? await open(ctxOrRoot) : ctxOrRoot;
  const sym = resolveSymbol(args.symbol, ctx);
  if (!sym) throw new Error(`symbol not found: ${args.symbol}`);

  const visited = new Set<string>();
  const frontier: SymbolRef[] = [sym];
  for (let hop = 0; hop < args.hops; hop++) {
    const next: SymbolRef[] = [];
    for (const current of frontier) {
      const key = current.id ?? current.qualified_name ?? current.name;
      visited.add(key);
      for (const c of callersOf(current, ctx)) {
        const callerKey = c.id ?? c.qualified_name ?? c.name;
        if (!visited.has(callerKey)) {
          visited.add(callerKey);
          next.push(c);
        }
      }
    }
    frontier.length = 0;
    frontier.push(...next);
  }
  visited.delete(sym.id ?? sym.qualified_name ?? sym.name);

  const L = lookups(ctx);
  const affected_symbols = [...visited]
    .map((id) => resolveByKey(id, L))
    .filter((s): s is SymbolRef => !!s);
  const affected_files = [...new Set(affected_symbols.map((s) => s.file))];

  // Batch test discovery: read each test file at most once, scan once for any
  // of the affected symbol names. Cuts O(N_symbols × F_tests) to O(F_tests).
  const names = new Set(affected_symbols.map((a) => a.name).filter((n) => n.length > 2));
  const candidates = testFilesIn(ctx.index);
  const affected_tests: TestRef[] = [];
  await Promise.all(
    candidates.map(async (t) => {
      try {
        const src = await readFile(path.join(ctx.root, t), "utf8");
        for (const n of names) {
          if (src.includes(n)) {
            affected_tests.push({ file: t, framework: frameworkFor(t), symbols_covered: [n] });
            return;
          }
        }
      } catch {
        // ignore
      }
    }),
  );

  return {
    symbol: sym,
    affected_symbols,
    affected_files,
    affected_tests,
    blast_radius: affected_symbols.length,
  };
}

export async function prepareEdit(
  args: PrepareEditInput,
  ctxOrRoot: QueryContext | string,
): Promise<PrepareEditResult> {
  // Symbol is optional in the wire schema (intent-only briefs infer it at
  // the CLI/MCP boundary). By the time we reach prepareEdit it must be set.
  if (!args.symbol) {
    throw new Error("prepareEdit: symbol is required (resolve intent → symbol before calling)");
  }
  const symbol = args.symbol;
  const ctx = typeof ctxOrRoot === "string" ? await open(ctxOrRoot) : ctxOrRoot;
  // prepareEdit already runs its own packByBudget on the markdown wrapper; ask
  // for the full structural payload here so the markdown packer has all data
  // to prioritise from.
  const c = await getContext(
    {
      symbol,
      depth: args.depth ?? 2,
      strands: ["structural", "tests", "provenance", "invariants"],
      mode: "full",
      budget: 0,
    },
    ctx,
  );

  const since = args.since ? parseSince(args.since) : undefined;
  const filteredNotes: Note[] = since ? c.notes.filter((n) => isAfter(n.recorded_at, since)) : c.notes;
  const filteredDecisions: Decision[] = since
    ? c.decisions.filter((d) => isAfter(d.recorded_at, since))
    : c.decisions;

  const symbolKey = c.symbol.qualified_name ?? c.symbol.name;
  const assumptionsAll = await loadAssumptions(ctx.root, symbolKey);
  const unverifiedAssumptions = assumptionsAll.filter((a) => !a.verified);
  const allQuestions = await loadQuestions(ctx.root, symbolKey);
  let unresolved: Question[] = filterByStatus(allQuestions, "unresolved");
  if (since) unresolved = unresolved.filter((q) => isAfter(q.recorded_at, since));

  const filteredContext: ContextResult = {
    ...c,
    notes: filteredNotes,
    decisions: filteredDecisions,
  };

  const depth = args.depth ?? 1;
  const neighbors = depth > 1 ? await neighborhood(ctx, c.symbol, depth) : [];
  const testGaps = await gapsForSymbol(ctx, c.symbol);

  const intentKind = classifyIntent(args.intent);
  const exclude = excludeForIntent(intentKind);

  const md = formatPrepareEdit(filteredContext, args.intent, args.budget, {
    questions: unresolved,
    neighbors,
    exclude,
    assumptions: unverifiedAssumptions,
    testGaps,
  });
  return {
    schema_version: PREPARE_EDIT_SCHEMA_VERSION,
    markdown: md,
    invariants_to_respect: c.invariants,
    notes: filteredNotes,
    decisions: filteredDecisions,
    preferences: c.preferences,
    tests_to_run: c.tests.map((t) => t.file),
    risk: c.risk,
  };
}

function computeRisk(p: {
  callers: SymbolRef[];
  tests: TestRef[];
  invariants: Invariant[];
  churn: number;
}): "low" | "medium" | "high" {
  const blocks = p.invariants.some((i) => i.severity === "block");
  const wide = p.callers.length >= 5;
  const untested = p.tests.length === 0 && p.callers.length > 0;
  const hot = p.churn >= 10;
  if (blocks || (wide && untested) || (wide && hot)) return "high";
  if (wide || untested || p.invariants.length > 0) return "medium";
  return "low";
}

async function safeChurn(root: string, file: string): Promise<number> {
  try {
    return await churn(root, file);
  } catch {
    return 0;
  }
}

export interface FormatPrepareOpts {
  /** Section keys to exclude (e.g. driven by intent classifier). */
  exclude?: Set<string>;
  /** Extra sections (e.g. test gaps, assumptions, neighborhood) to inject. */
  extra?: PackSection[];
  /** Open questions to surface in their own section. */
  questions?: Question[];
  /** Callees with their own knowledge attached. */
  neighbors?: NeighborEntry[];
  /** Unverified assumptions to flag. */
  assumptions?: Assumption[];
  /** Test gaps relative to current edit. */
  testGaps?: TestGap[];
}

function formatPrepareEdit(
  c: ContextResult,
  intent: string,
  budget?: number,
  opts: FormatPrepareOpts = {},
): string {
  const header: string[] = [];
  header.push(`# prepare_edit: ${c.symbol.name}`);
  header.push("");
  header.push(`**Intent:** ${intent}`);
  header.push(`**Defined in:** \`${c.symbol.file}:${c.symbol.line}\` (${c.symbol.kind})`);
  header.push(`**Risk:** ${c.risk.toUpperCase()}`);
  header.push("");

  const sections: PackSection[] = [];
  const add = (key: string, s: PackSection) => {
    if (opts.exclude?.has(key)) return;
    sections.push(s);
  };

  if (opts.assumptions && opts.assumptions.length > 0 && !opts.exclude?.has("assumptions")) {
    sections.push({
      heading: "## Assumptions to verify",
      items: opts.assumptions.map((a) => `- [${a.confidence}] ${a.statement}${a.evidence ? ` _(${a.evidence})_` : ""}`),
    });
  }

  add("invariants", {
    heading: "## Invariants that apply",
    items: c.invariants.map((inv) => {
      const evidence = inv.evidence.length ? `\n  - evidence: ${inv.evidence.join(", ")}` : "";
      return `- **${inv.name}** (${inv.severity}) — ${inv.rule}${evidence}`;
    }),
  });

  add("notes", {
    heading: "## Notes from previous edits",
    items: c.notes.map((n) => {
      const ev = n.evidence ? `\n  - evidence: ${n.evidence}` : "";
      return `- **[${n.severity}]** ${n.lesson}${ev}`;
    }),
  });

  add("preferences", {
    heading: "## User preferences that apply",
    items: c.preferences.map((p) => {
      const ev = p.evidence ? `\n  - evidence: ${p.evidence}` : "";
      return `- ${p.text}${ev}`;
    }),
  });

  if (opts.questions && opts.questions.length > 0) {
    add("questions", {
      heading: "## Open questions",
      items: opts.questions.map((q) => `- ${q.question}`),
    });
  }

  add("decisions", {
    heading: "## Past decisions",
    items: c.decisions.map((d) => {
      const parts = [`- **${d.decision}**`];
      if (d.rejected_alternative) parts.push(`  - rejected: ${d.rejected_alternative}`);
      if (d.rationale) parts.push(`  - rationale: ${d.rationale}`);
      const meta = [d.made_by && `by ${d.made_by}`, d.session && `from ${d.session}`]
        .filter(Boolean)
        .join(", ");
      if (meta) parts.push(`  - ${meta}`);
      return parts.join("\n");
    }),
  });

  add("callers", {
    heading: "## Called by",
    items: c.callers.slice(0, 10).map((x) => `- \`${x.name}\` — ${x.file}:${x.line}`),
    trailing: c.callers.length > 10 ? `- …and ${c.callers.length - 10} more` : undefined,
  });

  add("callees", {
    heading: "## Calls",
    items: c.callees.slice(0, 10).map((x) => `- \`${x.name}\` — ${x.file}:${x.line}`),
  });

  add("tests", c.tests.length
    ? {
        heading: "## Tests to run after editing",
        items: c.tests.map((t) => `- \`${t.file}\` (${t.framework})`),
      }
    : {
        heading: "## Tests",
        items: [],
        trailing: "_No tests found — adding a test for this change is recommended._",
      });

  add("provenance", {
    heading: "## Recent changes",
    items: c.provenance.slice(0, 5).map(
      (p) => `- \`${p.commit}\` ${p.date.slice(0, 10)} ${p.author}: ${p.message}`,
    ),
  });

  if (opts.testGaps && opts.testGaps.length > 0 && !opts.exclude?.has("testGaps")) {
    sections.push({
      heading: "## Test gaps",
      items: opts.testGaps.map(
        (g) => `- \`${g.callee}\` (${g.reason}) — ${g.file}`,
      ),
    });
  }

  if (opts.neighbors && opts.neighbors.length > 0 && !opts.exclude?.has("neighbors")) {
    const items: string[] = [];
    for (const n of opts.neighbors) {
      const symbolKey = n.symbol.qualified_name ?? n.symbol.name;
      items.push(`- \`${symbolKey}\` (depth ${n.depth})`);
      for (const inv of n.invariants) {
        items.push(`  - invariant: **${inv.name}** — ${inv.rule}`);
      }
      for (const note of n.notes) {
        items.push(`  - note [${note.severity}]: ${note.lesson}`);
      }
    }
    sections.push({ heading: "## Neighborhood context", items });
  }

  if (opts.extra) for (const s of opts.extra) sections.push(s);

  const packed = packByBudget(sections, budget ?? 0);
  let body = packed.text;
  const realBudgetDrops = packed.dropped.filter((d) => d.reason === "budget" && d.items > 0);
  if (budget && realBudgetDrops.length > 0) {
    body += "\n## Trimmed for budget\n";
    for (const d of realBudgetDrops) body += `- ${d.section}: ${d.items} items dropped\n`;
  }
  return header.join("\n") + body;
}
