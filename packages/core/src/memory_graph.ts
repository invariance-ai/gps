import { createHash } from "node:crypto";
import { recallMemory, type RecallHit, type RecallKind, type RecallRelatedSymbol } from "./recall.js";
import { findConflicts } from "./conflicts.js";
import { findStale } from "./stale.js";
import { readIndex, type GpsIndex } from "./index_store.js";
import { findPromotionCandidates } from "./promote.js";
import { searchSymbolsBm25, type SearchMatch } from "./search.js";

export type MemoryGraphNodeType = "memory" | "symbol";
export type MemoryGraphEdgeType = "anchors" | "calls" | "related" | "same_anchor" | "shares_symbol";

export interface MemoryGraphNode {
  id: string;
  type: MemoryGraphNodeType;
  label: string;
  kind?: string;
  text?: string;
  anchor?: string;
  score?: number;
  file?: string;
  line?: number;
}

export interface MemoryGraphEdge {
  from: string;
  to: string;
  type: MemoryGraphEdgeType;
}

export type MemoryGraphIssueKind = "conflict" | "stale" | "orphan_anchor" | "promotion_candidate" | "open_question" | "unverified_assumption" | "open_todo" | "memory_gap";

export interface MemoryGraphIssue {
  kind: MemoryGraphIssueKind;
  symbol: string;
  summary: string;
  severity: "info" | "warn" | "block";
  command: string;
}

export interface MemoryGraphCentralSymbol {
  symbol: string;
  file?: string;
  line?: number;
  degree: number;
  memory_count: number;
  issue_count: number;
}

export interface MemoryGraphSummary {
  memory_nodes: number;
  symbol_nodes: number;
  edges: number;
  issues: { total: number; block: number; warn: number; info: number };
  central_symbols: MemoryGraphCentralSymbol[];
}

export interface MemoryGraphRecommendation {
  kind: "resolve_issue" | "answer_question" | "verify_assumption" | "resolve_todo" | "promote_memory" | "inspect_symbol" | "record_memory";
  priority: "high" | "medium" | "low";
  command: string;
  reason: string;
  action?: MemoryGraphRecommendationAction;
}

export type MemoryGraphRecommendationAction =
  | { tool: "prepare_edit"; args: { symbol: string; intent?: string } }
  | { tool: "record_lesson"; args: { lesson: string; force_scope?: "symbol"; force_target?: string; evidence?: string } }
  | { tool: "questions_for"; args: { symbol: string; status: "unresolved" } }
  | { tool: "assumptions_for"; args: { symbol: string } }
  | { tool: "list_todos"; args: { symbol: string; include_resolved: false } }
  | { tool: "promotion_candidates"; args: { symbol: string } }
  | { tool: "find_conflicts"; args: { symbol: string } }
  | { tool: "find_stale"; args: { days: number } }
  | { tool: "validate_knowledge"; args: Record<string, never> };

export interface MemoryGraphOptions {
  limit?: number;
  kinds?: RecallKind[];
  relatedLimit?: number;
  /** Add topic-matching symbols from the index even when they have no memory yet. */
  includeSymbols?: boolean;
  /** Max direct topic-matching symbols to seed into the graph. */
  symbolLimit?: number;
  includeIssues?: boolean;
  staleDays?: number;
}

export interface MemoryGraphResult {
  query: string;
  summary: MemoryGraphSummary;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  issues: MemoryGraphIssue[];
  recommendations: MemoryGraphRecommendation[];
  hits: RecallHit[];
}

/**
 * Build a small, agent-readable knowledge graph around a topic. Memory nodes
 * come from recallMemory; symbol nodes and call edges come from recall's
 * optional graph expansion. This keeps "memory graph" as a projection of the
 * same governed memory + symbol index rather than a second persistence layer.
 */
export async function memoryGraph(
  root: string,
  query: string,
  opts: MemoryGraphOptions = {},
): Promise<MemoryGraphResult> {
  const hits = await recallMemory(root, query, {
    limit: opts.limit,
    kinds: opts.kinds,
    related: true,
    relatedLimit: opts.relatedLimit ?? 8,
  });
  const nodes = new Map<string, MemoryGraphNode>();
  const edges = new Map<string, MemoryGraphEdge>();
  const memoryByAnchor = new Map<string, string[]>();
  const memoryBySymbol = new Map<string, string[]>();
  const seededSymbols = new Map<string, MemoryGraphNode>();

  const addNode = (node: MemoryGraphNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };
  const addEdge = (edge: MemoryGraphEdge) => {
    const key = `${edge.from}->${edge.to}:${edge.type}`;
    if (!edges.has(key)) edges.set(key, edge);
  };

  for (const hit of hits) {
    const memoryId = memoryNodeId(hit);
    if (hit.anchor) pushMap(memoryByAnchor, normalizeKey(hit.anchor), memoryId);
    addNode({
      id: memoryId,
      type: "memory",
      label: memoryLabel(hit),
      kind: hit.kind,
      text: hit.text,
      anchor: hit.anchor,
      score: hit.score,
    });

    const related = hit.related_symbols ?? [];
    const anchors = related.filter((s) => s.relation === "anchor");
    for (const sym of related) {
      pushMap(memoryBySymbol, symbolNodeId(sym), memoryId);
      const symId = symbolNodeId(sym);
      addNode({
        id: symId,
        type: "symbol",
        label: sym.symbol,
        kind: sym.relation,
        file: sym.file,
        line: sym.line,
      });
      if (sym.relation === "anchor") {
        addEdge({ from: memoryId, to: symId, type: "anchors" });
      } else {
        addEdge({ from: memoryId, to: symId, type: "related" });
      }
    }

    for (const anchor of anchors) {
      const anchorId = symbolNodeId(anchor);
      for (const caller of related.filter((s) => s.relation === "caller")) {
        addEdge({ from: symbolNodeId(caller), to: anchorId, type: "calls" });
      }
      for (const callee of related.filter((s) => s.relation === "callee")) {
        addEdge({ from: anchorId, to: symbolNodeId(callee), type: "calls" });
      }
    }
  }

  if (opts.includeSymbols !== false) {
    await addSymbolSeeds(root, query, opts.symbolLimit ?? 5, nodes, edges, seededSymbols);
  }

  connectMemoryGroups(memoryByAnchor, "same_anchor", edges);
  connectMemoryGroups(memoryBySymbol, "shares_symbol", edges);
  const nodeList = [...nodes.values()];
  const edgeList = [...edges.values()];
  const issues =
    opts.includeIssues === false
      ? []
      : [
          ...(await graphIssues(root, hits, opts.staleDays ?? 90)),
          ...memoryGapIssues(query, nodeList, edgeList, seededSymbols),
        ];
  const summary = graphSummary(nodeList, edgeList, issues);

  return {
    query,
    summary,
    nodes: nodeList,
    edges: edgeList,
    issues,
    recommendations: graphRecommendations(query, summary, issues, opts.staleDays ?? 90),
    hits,
  };
}

function graphRecommendations(
  query: string,
  summary: MemoryGraphSummary,
  issues: MemoryGraphIssue[],
  staleDays: number,
): MemoryGraphRecommendation[] {
  const out: MemoryGraphRecommendation[] = [];
  for (const issue of issues.slice(0, 5)) {
    const kind = issue.kind === "promotion_candidate" ? "promote_memory" : issue.kind === "open_question" ? "answer_question" : issue.kind === "unverified_assumption" ? "verify_assumption" : issue.kind === "open_todo" ? "resolve_todo" : issue.kind === "memory_gap" ? "record_memory" : "resolve_issue";
    out.push({
      kind,
      priority: issue.severity === "block" ? "high" : issue.severity === "warn" ? "medium" : "low",
      command: issue.command,
      reason: `${issue.symbol}: ${issue.summary}`,
      action: recommendationAction(kind, issue, query, staleDays),
    });
  }
  for (const symbol of summary.central_symbols.slice(0, 3)) {
    const highestIssue = highestSeverityForSymbol(issues, symbol.symbol);
    const intent = `work on ${query}`;
    out.push({
      kind: "inspect_symbol",
      priority: highestIssue === "block" ? "high" : highestIssue === "warn" ? "medium" : symbol.memory_count > 0 || symbol.degree > 0 ? "medium" : "low",
      command: `gps prepare ${shellQuote(symbol.symbol)} --intent ${shellQuote(intent)}`,
      reason: `${symbol.symbol} is central to this memory graph (${symbol.memory_count} memory links, degree ${symbol.degree})`,
      action: {
        tool: "prepare_edit",
        args: { symbol: symbol.symbol, intent },
      },
    });
  }
  if (summary.memory_nodes === 0) {
    const lesson = `No durable memory found yet for topic: ${query}`;
    out.push({
      kind: "record_memory",
      priority: "low",
      command: `gps remember ${shellQuote(lesson)}`,
      reason: "No memory matched this topic; record the hard-won finding after the task if one emerges.",
      action: {
        tool: "record_lesson",
        args: { lesson },
      },
    });
  }
  return dedupeRecommendations(out).slice(0, 8);
}

function recommendationAction(
  kind: MemoryGraphRecommendation["kind"],
  issue: MemoryGraphIssue,
  query: string,
  staleDays: number,
): MemoryGraphRecommendationAction | undefined {
  switch (kind) {
    case "promote_memory":
      return { tool: "promotion_candidates", args: { symbol: issue.symbol } };
    case "answer_question":
      return { tool: "questions_for", args: { symbol: issue.symbol, status: "unresolved" } };
    case "verify_assumption":
      return { tool: "assumptions_for", args: { symbol: issue.symbol } };
    case "resolve_todo":
      return { tool: "list_todos", args: { symbol: issue.symbol, include_resolved: false } };
    case "record_memory":
      return {
        tool: "record_lesson",
        args: {
          lesson: `What matters about ${query} for ${issue.symbol}`,
          force_scope: "symbol",
          force_target: issue.symbol,
        },
      };
    case "resolve_issue":
      if (issue.kind === "conflict") return { tool: "find_conflicts", args: { symbol: issue.symbol } };
      if (issue.kind === "stale") return { tool: "find_stale", args: { days: staleDays } };
      if (issue.kind === "orphan_anchor") return { tool: "validate_knowledge", args: {} };
      return undefined;
    case "inspect_symbol":
      return undefined;
  }
}

function highestSeverityForSymbol(
  issues: MemoryGraphIssue[],
  symbol: string,
): MemoryGraphIssue["severity"] | undefined {
  let highest: MemoryGraphIssue["severity"] | undefined;
  for (const issue of issues) {
    if (issue.symbol !== symbol) continue;
    if (!highest || severityRank(issue.severity) > severityRank(highest)) highest = issue.severity;
  }
  return highest;
}

async function addSymbolSeeds(
  root: string,
  query: string,
  limit: number,
  nodes: Map<string, MemoryGraphNode>,
  edges: Map<string, MemoryGraphEdge>,
  seededSymbols: Map<string, MemoryGraphNode>,
): Promise<void> {
  if (limit <= 0) return;
  let index: GpsIndex;
  try {
    index = await readIndex(root);
  } catch {
    return;
  }
  const lookup = indexLookup(index);
  for (const match of searchSymbolsBm25(index, query, limit)) {
    const seed = addSymbolMatchNode(match, "match", nodes);
    seededSymbols.set(seed.id, seed);
    for (const key of symbolKeys(match.symbol)) {
      for (const caller of lookup.callers.get(key) ?? []) {
        const callerNode = addSymbolNode(caller, "caller", nodes);
        addEdge(edges, callerNode.id, seed.id, "calls");
      }
      for (const callee of lookup.callees.get(key) ?? []) {
        const calleeNode = addSymbolNode(callee, "callee", nodes);
        addEdge(edges, seed.id, calleeNode.id, "calls");
      }
    }
  }
}

function memoryGapIssues(
  query: string,
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  seededSymbols: Map<string, MemoryGraphNode>,
): MemoryGraphIssue[] {
  if (seededSymbols.size === 0) return [];
  const memoryLinkedSymbols = new Set<string>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const edge of edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from?.type === "memory" && to?.type === "symbol") memoryLinkedSymbols.add(to.id);
    if (to?.type === "memory" && from?.type === "symbol") memoryLinkedSymbols.add(from.id);
  }
  const out: MemoryGraphIssue[] = [];
  for (const node of seededSymbols.values()) {
    if (memoryLinkedSymbols.has(node.id)) continue;
    out.push({
      kind: "memory_gap",
      symbol: node.label,
      summary: `topic matches code, but no recalled memory is attached to this symbol`,
      severity: "info",
      command: `gps remember ${shellQuote(`What matters about ${query} for ${node.label}`)} --symbol ${shellQuote(node.label)}`,
    });
  }
  return out;
}

function graphSummary(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  issues: MemoryGraphIssue[],
): MemoryGraphSummary {
  const issueCounts = {
    total: issues.length,
    block: issues.filter((i) => i.severity === "block").length,
    warn: issues.filter((i) => i.severity === "warn").length,
    info: issues.filter((i) => i.severity === "info").length,
  };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const symbolStats = new Map<string, MemoryGraphCentralSymbol>();
  const ensure = (n: MemoryGraphNode): MemoryGraphCentralSymbol | undefined => {
    if (n.type !== "symbol") return undefined;
    const existing = symbolStats.get(n.id);
    if (existing) return existing;
    const next = {
      symbol: n.label,
      file: n.file,
      line: n.line,
      degree: 0,
      memory_count: 0,
      issue_count: issues.filter((i) => i.symbol === n.label).length,
    };
    symbolStats.set(n.id, next);
    return next;
  };
  for (const n of nodes) ensure(n);
  for (const e of edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    const fromStats = from ? ensure(from) : undefined;
    const toStats = to ? ensure(to) : undefined;
    if (fromStats) fromStats.degree++;
    if (toStats) toStats.degree++;
    if (e.type === "anchors" || e.type === "related") {
      if (from?.type === "memory" && toStats) toStats.memory_count++;
      if (to?.type === "memory" && fromStats) fromStats.memory_count++;
    }
  }
  return {
    memory_nodes: nodes.filter((n) => n.type === "memory").length,
    symbol_nodes: nodes.filter((n) => n.type === "symbol").length,
    edges: edges.length,
    issues: issueCounts,
    central_symbols: [...symbolStats.values()]
      .sort(
        (a, b) =>
          b.issue_count - a.issue_count ||
          b.memory_count - a.memory_count ||
          b.degree - a.degree ||
          a.symbol.localeCompare(b.symbol),
      )
      .slice(0, 8),
  };
}

interface IndexLookup {
  callers: Map<string, GpsIndex["symbols"][number][]>;
  callees: Map<string, GpsIndex["symbols"][number][]>;
}

function indexLookup(index: GpsIndex): IndexLookup {
  const byKey = new Map<string, GpsIndex["symbols"][number]>();
  for (const symbol of index.symbols) {
    for (const key of symbolKeys(symbol)) byKey.set(key, symbol);
  }
  const callers = new Map<string, GpsIndex["symbols"][number][]>();
  const callees = new Map<string, GpsIndex["symbols"][number][]>();
  for (const edge of index.edges) {
    const fromKey = edge.from_id ?? edge.from;
    const toKey = edge.to_id ?? edge.to;
    const from = byKey.get(fromKey);
    const to = byKey.get(toKey);
    if (!from || !to) continue;
    for (const key of symbolKeys(to)) pushMap(callers, key, from);
    for (const key of symbolKeys(from)) pushMap(callees, key, to);
  }
  return { callers, callees };
}

function addSymbolMatchNode(
  match: SearchMatch,
  relation: string,
  nodes: Map<string, MemoryGraphNode>,
): MemoryGraphNode {
  const node = symbolRefNode(match.symbol, relation, match.score);
  if (!nodes.has(node.id)) nodes.set(node.id, node);
  return nodes.get(node.id)!;
}

function addSymbolNode(
  symbol: GpsIndex["symbols"][number],
  relation: string,
  nodes: Map<string, MemoryGraphNode>,
): MemoryGraphNode {
  const node = symbolRefNode(symbol, relation);
  if (!nodes.has(node.id)) nodes.set(node.id, node);
  return nodes.get(node.id)!;
}

function addEdge(
  edges: Map<string, MemoryGraphEdge>,
  from: string,
  to: string,
  type: MemoryGraphEdgeType,
): void {
  const key = `${from}->${to}:${type}`;
  if (!edges.has(key)) edges.set(key, { from, to, type });
}

function symbolRefNode(
  symbol: GpsIndex["symbols"][number],
  relation: string,
  score?: number,
): MemoryGraphNode {
  return {
    id: symbolRefNodeId(symbol),
    type: "symbol",
    label: symbol.qualified_name ?? symbol.name,
    kind: relation,
    file: symbol.file,
    line: symbol.line,
    ...(score === undefined ? {} : { score }),
  };
}

async function graphIssues(root: string, hits: RecallHit[], staleDays: number): Promise<MemoryGraphIssue[]> {
  const symbols = symbolsForIssues(hits);
  const issues: MemoryGraphIssue[] = [];
  const hasIndex = await readIndex(root).then(() => true, () => false);
  if (hasIndex) issues.push(...orphanAnchorIssues(hits));
  issues.push(...openQuestionIssues(hits));
  issues.push(...unverifiedAssumptionIssues(hits));
  issues.push(...openTodoIssues(hits));
  if (symbols.size === 0) return dedupeIssues(issues);
  for (const symbol of symbols) {
    for (const c of await findConflicts(root, symbol)) {
      issues.push({
        kind: "conflict",
        symbol,
        summary: c.summary,
        severity: c.kind === "contradicts" ? "block" : "warn",
        command: `gps conflicts ${shellQuote(symbol)}`,
      });
    }
    for (const c of await findPromotionCandidates(root, symbol)) {
      issues.push({
        kind: "promotion_candidate",
        symbol,
        summary: `${c.notes.length} similar notes can be promoted to an invariant (${c.severity_hint})`,
        severity: c.severity_hint,
        command: `gps promote ${shellQuote(symbol)}`,
      });
    }
  }
  const stale = await findStale(root, { days: staleDays }).catch(() => []);
  for (const s of stale) {
    if (!symbols.has(s.symbol)) continue;
    issues.push({
      kind: "stale",
      symbol: s.symbol,
      summary: `${s.kind} is ${s.age_days}d old${s.file_changed_since ? " and its file changed since" : ""}`,
      severity: s.file_changed_since ? "warn" : "info",
      command: `gps stale --days ${staleDays} --changed-only`,
    });
  }
  return dedupeIssues(issues).sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.symbol.localeCompare(b.symbol));
}

function openTodoIssues(hits: RecallHit[]): MemoryGraphIssue[] {
  const out: MemoryGraphIssue[] = [];
  for (const h of hits) {
    if (h.kind !== "todo") continue;
    const anchors = memoryAnchorSymbols(h.anchor);
    if (anchors.length > 0) {
      for (const symbol of anchors) {
        out.push({
          kind: "open_todo",
          symbol,
          summary: h.text,
          severity: h.source === "failure" ? "warn" : "info",
          command: `gps todos ${shellQuote(symbol)}`,
        });
      }
      continue;
    }
    const file = fileAnchor(h.anchor);
    if (file) {
      out.push({
        kind: "open_todo",
        symbol: file,
        summary: h.text,
        severity: h.source === "failure" ? "warn" : "info",
        command: `gps todos --file ${shellQuote(file)}`,
      });
    }
  }
  return out;
}

function unverifiedAssumptionIssues(hits: RecallHit[]): MemoryGraphIssue[] {
  const out: MemoryGraphIssue[] = [];
  for (const h of hits) {
    if (h.kind !== "assumption") continue;
    for (const symbol of memoryAnchorSymbols(h.anchor)) {
      out.push({
        kind: "unverified_assumption",
        symbol,
        summary: h.text,
        severity: h.severity === "high" ? "warn" : "info",
        command: `gps assumptions ${shellQuote(symbol)} --unverified`,
      });
    }
  }
  return out;
}

function openQuestionIssues(hits: RecallHit[]): MemoryGraphIssue[] {
  const out: MemoryGraphIssue[] = [];
  for (const h of hits) {
    if (h.kind !== "question") continue;
    for (const symbol of memoryAnchorSymbols(h.anchor)) {
      out.push({
        kind: "open_question",
        symbol,
        summary: h.text,
        severity: "warn",
        command: `gps questions ${shellQuote(symbol)} --status unresolved`,
      });
    }
  }
  return out;
}

function orphanAnchorIssues(hits: RecallHit[]): MemoryGraphIssue[] {
  const out: MemoryGraphIssue[] = [];
  for (const h of hits) {
    const anchors = memoryAnchorSymbols(h.anchor);
    if (anchors.length === 0) continue;
    const connected = new Set((h.related_symbols ?? []).filter((s) => s.relation === "anchor").map((s) => s.symbol));
    for (const symbol of anchors) {
      if (connected.has(symbol)) continue;
      out.push({
        kind: "orphan_anchor",
        symbol,
        summary: `${h.kind} matched this topic, but its anchor is not connected to the current symbol graph`,
        severity: "warn",
        command: `gps validate-knowledge && gps find ${shellQuote(symbol)}`,
      });
    }
  }
  return out;
}

function symbolsForIssues(hits: RecallHit[]): Set<string> {
  const out = new Set<string>();
  for (const h of hits) {
    for (const symbol of memoryAnchorSymbols(h.anchor)) out.add(symbol);
    for (const s of h.related_symbols ?? []) {
      if (s.relation === "anchor") out.add(s.symbol);
    }
  }
  return out;
}

function memoryAnchorSymbols(anchor?: string): string[] {
  if (!anchor || /^(?:file|area|feature):/.test(anchor)) return [];
  return anchor.split(",").map((part) => part.trim()).filter(Boolean);
}

function fileAnchor(anchor?: string): string | undefined {
  const match = /^file:(.+)$/.exec(anchor ?? "");
  return match?.[1];
}

function memoryNodeId(hit: RecallHit): string {
  return `memory:${hash([hit.kind, hit.anchor ?? "", hit.text].join("\0"))}`;
}

function symbolNodeId(sym: RecallRelatedSymbol): string {
  return `symbol:${hash([sym.symbol, sym.file, String(sym.line)].join("\0"))}`;
}

function symbolRefNodeId(sym: Pick<GpsIndex["symbols"][number], "name" | "qualified_name" | "file" | "line">): string {
  return `symbol:${hash([sym.qualified_name ?? sym.name, sym.file, String(sym.line)].join("\0"))}`;
}

function symbolKeys(sym: Pick<GpsIndex["symbols"][number], "id" | "name" | "qualified_name">): string[] {
  return [sym.id, sym.qualified_name, sym.name].filter((key): key is string => !!key);
}

function memoryLabel(hit: RecallHit): string {
  const anchor = hit.anchor ? ` ${hit.anchor}` : "";
  return `${hit.kind}${anchor}`;
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function connectMemoryGroups(
  groups: Map<string, string[]>,
  type: Extract<MemoryGraphEdgeType, "same_anchor" | "shares_symbol">,
  edges: Map<string, MemoryGraphEdge>,
): void {
  for (const ids of groups.values()) {
    const unique = [...new Set(ids)].sort();
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const edge = { from: unique[i]!, to: unique[j]!, type };
        edges.set(`${edge.from}->${edge.to}:${edge.type}`, edge);
      }
    }
  }
}

function pushMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function dedupeIssues(items: MemoryGraphIssue[]): MemoryGraphIssue[] {
  const seen = new Set<string>();
  const out: MemoryGraphIssue[] = [];
  for (const item of items) {
    const key = `${item.kind}|${item.symbol}|${item.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function dedupeRecommendations(items: MemoryGraphRecommendation[]): MemoryGraphRecommendation[] {
  const seen = new Set<string>();
  const out: MemoryGraphRecommendation[] = [];
  for (const item of items) {
    const key = `${item.kind}|${item.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function severityRank(severity: MemoryGraphIssue["severity"]): number {
  return severity === "block" ? 3 : severity === "warn" ? 2 : 1;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
