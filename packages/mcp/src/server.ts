import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TOOLS, type NoteScope, type ToolName } from "@invariance/gps-schemas";
import {
  open as openQuery,
  getContext,
  impactOf,
  prepareEdit,
  resolveSymbol,
  testsForSymbol,
  loadInvariants,
  invariantsFor,
  loadNotes,
  appendNote,
  rankNotes,
  loadDecisions,
  appendDecision,
  rankDecisions,
  recordObservation,
  suggest as suggestImpl,
  classifyLesson,
  persistLesson,
  listLessons,
  reclassifyLesson,
  recordDirective,
  listTodos,
  resolveTodo,
  gate,
  auditSession,
  featureHealth,
  allFeatureHealth,
  findConflicts,
  findStale,
  appendQuestion,
  setStatus as setQuestionStatus,
  loadAllQuestions,
  loadQuestions,
  filterByStatus as filterQuestionsByStatus,
  appendAssumption,
  loadAssumptions,
  rankContributors,
  addPreference,
  recordPreference,
  loadPreferences,
  buildContract,
  saveContract,
  verifyContract,
  findRejectedConflicts,
  findPromotionCandidates,
  readIndex,
  recallMemory,
  type RecallKind as RecallKindT,
  verifyIndex,
  readGateStream,
  gateChanged,
  inferSymbols,
  seed,
  ALL_SOURCE_GLOBS,
  validateKnowledge,
  brief,
  hardSearchSuggestionsForActiveSession,
  pruneNotes,
  resume,
} from "@invariance/gps-core";
import { llmClassify } from "@invariance/gps-llm";

const OBSERVE = process.env.GPS_OBSERVE === "1";

function symbolFor(args: unknown): string | undefined {
  if (typeof args === "object" && args && "symbol" in args) {
    const s = (args as { symbol: unknown }).symbol;
    return typeof s === "string" ? s : undefined;
  }
  return undefined;
}

/**
 * Tool metadata flows from @invariance/gps-schemas so CLI flags, MCP tool I/O,
 * and HTTP OpenAPI stay in sync. Indexes are read from the cwd's .gps/ on each
 * call — cheap because the index is a single JSON file.
 */
const server = new Server(
  { name: "gps", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

/** The MCP tool list derived from the shared TOOLS registry. Exported for tests. */
export function listTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return Object.entries(TOOLS).map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: toJsonSchema(def.input),
  }));
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name as ToolName;
  const args = req.params.arguments ?? {};
  const def = TOOLS[name];
  if (!def) throw new Error(`Unknown tool: ${name}`);
  const parsed = def.input.parse(args);
  if (OBSERVE) {
    // Fire-and-forget: never block the response on observation IO.
    void recordObservation(process.cwd(), name, symbolFor(parsed)).catch(() => {
      /* swallow */
    });
  }
  const result = await dispatch(name, parsed);
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

export async function dispatch(name: ToolName, args: unknown): Promise<unknown> {
  const root = process.cwd();
  switch (name) {
    case "prepare_edit": {
      const a = args as { symbol?: string; intent: string; budget?: number; since?: string; depth?: number };
      let symbol = a.symbol;
      let candidates: Array<{ symbol: string; score: number; via: string }> | undefined;
      let lowConfidence = false;
      if (!symbol && a.intent) {
        const matches = await inferSymbols(root, a.intent, { limit: 5 });
        if (matches.length === 0) {
          throw new Error(
            `prepare_edit: no symbol matched intent "${a.intent}". ` +
              `Use the \`find\` tool (or \`gps find "<keyword>"\`) to locate the symbol, then pass it as \`symbol\`.`,
          );
        }
        candidates = matches.map((m) => ({
          symbol: m.symbol.qualified_name ?? m.symbol.name,
          score: m.score,
          via: m.via,
        }));
        symbol = candidates[0]!.symbol;
        const LOW_CONFIDENCE_THRESHOLD = 70;
        lowConfidence = candidates.length === 1 && (candidates[0]!.score ?? 0) < LOW_CONFIDENCE_THRESHOLD;
      }
      if (!symbol) throw new Error("prepare_edit: symbol or intent required");
      const result = await prepareEdit(
        {
          symbol,
          intent: a.intent,
          budget: a.budget,
          since: a.since,
          depth: a.depth,
          ...(candidates && candidates.length > 0 ? { candidates } : {}),
        },
        root,
      );
      const withCandidates = candidates && candidates.length > 1 ? { ...result, candidates } : result;
      return lowConfidence ? { ...withCandidates, low_confidence: true } : withCandidates;
    }
    case "get_context":
      return getContext(args as Parameters<typeof getContext>[0], root);
    case "impact_of":
      return impactOf(args as Parameters<typeof impactOf>[0], root);
    case "tests_for": {
      const a = args as { symbol: string };
      const ctx = await openQuery(root);
      const sym = resolveSymbol(a.symbol, ctx);
      if (!sym) throw new Error(`symbol not found: ${a.symbol}`);
      const tests = await testsForSymbol(sym.name, sym.file, root, ctx.index);
      return { symbol: sym, tests };
    }
    case "invariants_for": {
      const a = args as { symbol: string };
      const all = await loadInvariants(root);
      return { symbol: a.symbol, invariants: invariantsFor(a.symbol, all) };
    }
    case "record_learning": {
      const a = args as {
        symbol: string;
        lesson: string;
        evidence?: string;
        severity?: "low" | "medium" | "high";
        source?: "agent" | "human" | "doc" | "git" | "promoted" | "todo";
      };
      return appendNote(root, a);
    }
    case "notes_for": {
      const a = args as { symbol: string; include_promoted?: boolean };
      const all = await loadNotes(root, a.symbol);
      const notes = rankNotes(all, Number.POSITIVE_INFINITY, !!a.include_promoted);
      return { symbol: a.symbol, notes };
    }
    case "record_decision": {
      const a = args as Parameters<typeof appendDecision>[1];
      return appendDecision(root, a);
    }
    case "decisions_for": {
      const a = args as { symbol: string };
      const decisions = rankDecisions(await loadDecisions(root, a.symbol), Number.POSITIVE_INFINITY);
      return { symbol: a.symbol, decisions };
    }
    case "suggest": {
      const a = args as Parameters<typeof suggestImpl>[1];
      return { suggestions: await suggestImpl(root, a) };
    }
    case "record_lesson": {
      const a = args as {
        lesson: string;
        evidence?: string;
        severity?: "low" | "medium" | "high";
        hint_scope?: "global" | "symbol" | "file" | "feature" | "area";
        hint_target?: string;
        force_scope?: "global" | "symbol" | "file" | "feature" | "area";
        force_target?: string;
        dry_run?: boolean;
        no_llm?: boolean;
      };
      let scope: NoteScope | undefined = a.force_scope;
      let target = a.force_target;
      let signals: string[] = [];
      let confidence = 1;
      let used_llm = false;
      if (!scope) {
        const heuristic = await classifyLesson(root, a.lesson);
        scope = heuristic.scope;
        target = heuristic.target;
        signals = heuristic.signals;
        confidence = heuristic.confidence;
        if (a.hint_scope && (heuristic.ambiguous || confidence < 0.8)) {
          scope = a.hint_scope;
          target = a.hint_target ?? target;
          signals.push("hint-applied");
        }
        if (!a.no_llm && (heuristic.ambiguous || confidence < 0.8)) {
          const llm = await llmClassify(
            root,
            a.lesson,
            heuristic.candidates,
            heuristic.signals,
            { scope, target, reason: "heuristic fallback" },
          );
          scope = llm.decision.scope;
          target = llm.decision.target ?? target;
          used_llm = llm.used_llm;
          if (llm.used_llm) signals.push("llm");
        }
      } else if (scope !== "global" && !target) {
        throw new Error(`force_scope=${scope} requires force_target`);
      } else {
        signals = ["forced"];
      }
      if (a.dry_run) {
        if (!scope) throw new Error("record_learning: unable to classify lesson scope");
        return {
          scope,
          target,
          path: scope === "global" ? "CLAUDE.md" : "<dry-run>",
          id: "<dry-run>",
          signals,
          confidence,
          used_llm,
          dry_run: true,
        };
      }
      if (!scope) throw new Error("record_learning: unable to classify lesson scope");
      const persisted = await persistLesson(root, {
        scope,
        target,
        lesson: a.lesson,
        evidence: a.evidence,
        severity: a.severity,
        classifier: { signals, confidence, used_llm },
      });
      return {
        ...persisted,
        signals,
        confidence,
        used_llm,
        dry_run: false,
      };
    }
    case "lessons_list": {
      const a = args as {
        scope?: "global" | "symbol" | "file" | "feature" | "area";
        target?: string;
      };
      const lessons = await listLessons(root, a);
      return { lessons };
    }
    case "reclassify_lesson": {
      const a = args as {
        id: string;
        to_scope: "global" | "symbol" | "file" | "feature" | "area";
        to_target?: string;
      };
      return reclassifyLesson(root, a);
    }
    case "record_directive": {
      const a = args as {
        directive: string;
        polarity?: "do" | "dont";
        area?: string;
        alias?: string;
        evidence?: string;
        severity?: "low" | "medium" | "high";
      };
      return recordDirective(root, a);
    }
    case "find_reusable": {
      const a = args as { query: string; kind?: string; limit?: number };
      const ctx = await openQuery(root);
      const q = a.query.toLowerCase();
      const cands = ctx.index.symbols
        .map((s) => {
          if (a.kind && s.kind !== a.kind) return null;
          const n = s.name.toLowerCase();
          const qn = s.qualified_name?.toLowerCase();
          let score = 0;
          if (qn === q) score = 1;
          else if (n === q) score = 0.95;
          else if (qn?.startsWith(q)) score = 0.85;
          else if (n.startsWith(q)) score = 0.8;
          else if (qn?.includes(q)) score = 0.65;
          else if (n.includes(q)) score = 0.6;
          else return null;
          return { symbol: s, score };
        })
        .filter((x): x is { symbol: typeof ctx.index.symbols[0]; score: number } => !!x)
        .sort((a, b) => b.score - a.score)
        .slice(0, a.limit ?? 10);
      return { candidates: cands };
    }
    case "recall_memory": {
      const a = args as { query: string; limit?: number; kinds?: RecallKindT[] };
      const hits = await recallMemory(root, a.query, { limit: a.limit, kinds: a.kinds });
      return { query: a.query, hits };
    }
    case "list_todos": {
      const a = args as { file?: string; symbol?: string; include_resolved?: boolean };
      const todos = await listTodos(root, {
        file: a.file,
        symbol: a.symbol,
        includeResolved: !!a.include_resolved,
      });
      return { todos };
    }
    case "resolve_todo": {
      const a = args as { id: string };
      const resolved = await resolveTodo(root, a.id);
      return { resolved };
    }
    case "gate_check": {
      const a = args as { base?: string; files?: string[] };
      const result = await gate(root, a);
      return {
        base: result.base,
        changed_files: result.changed_files,
        changed_symbols: result.changed_symbols,
        hits: result.hits.map((h) => ({
          invariant: h.invariant,
          symbols: h.symbols,
          files: h.files,
          waived: h.waived,
        })),
        blocking: result.blocking.map((h) => ({
          invariant: h.invariant,
          symbols: h.symbols,
          files: h.files,
          waived: h.waived,
        })),
      };
    }
    case "audit_session": {
      const report = await auditSession(root);
      return report;
    }
    case "feature_health": {
      const a = args as { feature?: string };
      if (a.feature) {
        const h = await featureHealth(root, a.feature);
        return { features: h ? [h] : [] };
      }
      return { features: await allFeatureHealth(root) };
    }
    case "find_conflicts": {
      const a = args as { symbol: string };
      const conflicts = await findConflicts(root, a.symbol);
      return { symbol: a.symbol, conflicts };
    }
    case "find_stale": {
      const a = args as { days?: number; feature?: string };
      const entries = await findStale(root, a);
      return { entries };
    }
    case "record_question": {
      const a = args as Parameters<typeof appendQuestion>[1];
      return appendQuestion(root, a);
    }
    case "questions_for": {
      const a = args as { symbol?: string; status?: "unresolved" | "resolved" | "wontfix" };
      const qs = a.symbol
        ? await loadQuestions(root, a.symbol)
        : await loadAllQuestions(root);
      return { questions: filterQuestionsByStatus(qs, a.status) };
    }
    case "resolve_question": {
      const a = args as {
        symbol: string;
        id: string;
        status: "unresolved" | "resolved" | "wontfix";
        resolution?: string;
      };
      const updated = await setQuestionStatus(root, a.symbol, a.id, a.status, a.resolution);
      return { question: updated };
    }
    case "record_assumption": {
      const a = args as Parameters<typeof appendAssumption>[1];
      return appendAssumption(root, a);
    }
    case "assumptions_for": {
      const a = args as { symbol: string };
      const assumptions = await loadAssumptions(root, a.symbol);
      return { symbol: a.symbol, assumptions };
    }
    case "contributors_for": {
      const a = args as { symbol: string };
      const contributors = await rankContributors(root, a.symbol);
      return { symbol: a.symbol, contributors };
    }
    case "record_preference": {
      const a = args as Parameters<typeof addPreference>[1];
      // Honor the capture gate (Fix 4, option A): under capture=inbox this
      // queues for review instead of writing straight to active memory. The
      // response states where the memory went and why.
      return recordPreference(root, a);
    }
    case "preferences_list": {
      const preferences = await loadPreferences(root);
      return { preferences };
    }
    case "build_contract": {
      const a = args as { symbol: string; intent?: string; save?: boolean };
      const contract = await buildContract(root, { symbol: a.symbol, intent: a.intent });
      const shouldSave = a.save ?? true;
      if (shouldSave) await saveContract(root, contract);
      return { contract, saved: shouldSave };
    }
    case "verify_contract": {
      const a = args as { base?: string };
      const result = await verifyContract(root, a.base ?? "HEAD");
      if (!result) return { contract: undefined, diff_files: [], diff_symbols: [], violations: [] };
      return result;
    }
    case "check_proposal": {
      const a = args as {
        symbol?: string;
        proposal: string;
        threshold?: number;
        limit?: number;
      };
      const matches = await findRejectedConflicts(root, a.proposal, {
        symbol: a.symbol,
        threshold: a.threshold,
        limit: a.limit,
      });
      return { matches };
    }
    case "promotion_candidates": {
      const a = args as { symbol: string; min_occurrences?: number; threshold?: number };
      const candidates = await findPromotionCandidates(
        root,
        a.symbol,
        a.min_occurrences,
        a.threshold,
      );
      return { candidates };
    }
    case "verify_index": {
      const a = args as { sample?: number };
      const index = await readIndex(root);
      return verifyIndex(index, { root, sample: a.sample });
    }
    case "gate_stream": {
      const a = args as { since?: string; since_seq?: number; limit?: number };
      const entries = await readGateStream(root, a);
      return { entries };
    }
    case "review_diff": {
      const a = args as { base?: string };
      return gateChanged(root, { base: a.base });
    }
    case "validate_knowledge": {
      return validateKnowledge(root);
    }
    case "brief": {
      const a = args as { base?: string; max_symbols?: number };
      const result = await brief(root, { base: a.base, max_symbols: a.max_symbols });
      // Surface the agent-friction "remember candidate" to MCP-only agents
      // (e.g. Cursor) that never see the CLI `gps done` / `gps suggest` output.
      const memory_suggestions = await hardSearchSuggestionsForActiveSession(root);
      return { ...result, memory_suggestions };
    }
    case "seed_propose": {
      const a = args as { tier?: "safe" | "medium" | "aggressive"; limit?: number };
      const tier = a.tier ?? "safe";
      const cfg = tier === "safe"
        ? { maxCommits: 0, maxPrs: 0, minConfidence: 0.6, sources: ["todo"] }
        : tier === "medium"
        ? { maxCommits: 100, maxPrs: 20, minConfidence: 0.4, sources: ["todo", "commit", "pr"] }
        : { maxCommits: 500, maxPrs: 100, minConfidence: 0.2, sources: ["todo", "commit", "pr", "blame"] };
      const r = await seed(root, {
        maxCommits: cfg.maxCommits,
        maxPrs: cfg.maxPrs,
        scanFiles: ALL_SOURCE_GLOBS,
      });
      let proposals = r.proposals.filter(
        (p) => (p.confidence ?? 0) >= cfg.minConfidence && cfg.sources.includes(p.source),
      );
      if (a.limit) proposals = proposals.slice(0, a.limit);
      return { tier, proposals, scanned: r.scanned };
    }
    case "prune": {
      const a = args as { days?: number; min_confidence?: number; auto?: boolean; interval_days?: number; dry_run?: boolean };
      return pruneNotes(root, {
        days: a.days,
        minConfidence: a.min_confidence,
        auto: a.auto,
        intervalDays: a.interval_days,
        dryRun: a.dry_run,
      } as Parameters<typeof pruneNotes>[1]);
    }
    case "resume": {
      return resume(root);
    }
    default:
      throw new Error(`Tool ${name} dispatch not implemented`);
  }
}

// Connect on import (this is how `gps serve` launches us). Tests set
// GPS_MCP_NO_CONNECT=1 to import the module for its exports without binding
// stdio.
if (!process.env.GPS_MCP_NO_CONNECT) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodDefault || schema instanceof z.ZodOptional) {
    return toJsonSchema(schema._def.innerType);
  }
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodNumber) {
    const out: Record<string, unknown> = { type: "number" };
    for (const check of schema._def.checks) {
      if (check.kind === "int") out.type = "integer";
      if (check.kind === "min") out.minimum = check.value;
      if (check.kind === "max") out.maximum = check.value;
    }
    return out;
  }
  if (schema instanceof z.ZodEnum) return { type: "string", enum: schema.options };
  if (schema instanceof z.ZodArray) return { type: "array", items: toJsonSchema(schema.element) };
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(schema.shape)) {
      const child = value as z.ZodTypeAny;
      properties[key] = toJsonSchema(child);
      if (!(child instanceof z.ZodDefault) && !(child instanceof z.ZodOptional)) required.push(key);
    }
    return { type: "object", properties, required, additionalProperties: false };
  }
  return {};
}
