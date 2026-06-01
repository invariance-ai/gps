import { z } from "zod";

/**
 * Single source of truth for gps's data shapes.
 * CLI args, MCP tool I/O, and HTTP OpenAPI all derive from these.
 */

export const SymbolKind = z.enum([
  "function",
  "class",
  "method",
  "variable",
  "type",
  "module",
]);
export type SymbolKind = z.infer<typeof SymbolKind>;

export const SymbolRef = z.object({
  id: z.string().optional(),
  name: z.string(),
  qualified_name: z.string().optional(),
  container: z.string().optional(),
  file: z.string(),
  line: z.number().int().nonnegative(),
  /**
   * Last source line covered by the symbol body (1-indexed, inclusive).
   * Optional for back-compat with v0.1/v0.2 indexes; absent ⇒ caller should
   * treat as a 1-line symbol (degrades to start-line-only behavior).
   */
  end_line: z.number().int().nonnegative().optional(),
  kind: SymbolKind,
  /**
   * Bounded, deduped lowercased token set drawn from the symbol's source slice
   * (identifiers split on camelCase/snake_case, comment and signature words),
   * stored space-joined to keep the pretty-printed index compact. Powers
   * semantic `gps find` — matching what a symbol *does*, not just its name.
   * Populated at index time (index version ≥ 2); absent on older indexes, in
   * which case search degrades to name-only.
   */
  tokens: z.string().optional(),
});
export type SymbolRef = z.infer<typeof SymbolRef>;

/**
 * Edge confidence, ordered most-to-least trustworthy:
 *   exact      — resolved via import binding + symbol table; same file or
 *                resolved module path; we know the exact target symbol.
 *   typed      — confirmed by an external type oracle (tsserver / pyright).
 *   heuristic  — name-matched against the symbol index (current regex behavior).
 *   unresolved — callee identified but no candidate target found.
 *   name-only  — legacy label for v0.1 regex graph; same semantics as heuristic.
 */
export const ResolutionStatus = z.enum([
  "exact",
  "typed",
  "heuristic",
  "unresolved",
  "name-only",
]);
export type ResolutionStatus = z.infer<typeof ResolutionStatus>;

export const Edge = z.object({
  type: z.enum([
    "calls",
    "called_by",
    "imports",
    "imported_by",
    "reads",
    "writes",
    "tests",
    "tested_by",
    "inherits",
    "implements",
  ]),
  target: SymbolRef,
  resolution_status: ResolutionStatus.optional(),
});
export type Edge = z.infer<typeof Edge>;

export const JsonSchema = z.record(z.unknown());
export type JsonSchema = z.infer<typeof JsonSchema>;

export const ProvenanceEntry = z.object({
  commit: z.string(),
  author: z.string(),
  date: z.string(),
  message: z.string(),
});
export type ProvenanceEntry = z.infer<typeof ProvenanceEntry>;

export const Invariant = z.object({
  name: z.string(),
  applies_to: z.array(z.string()),
  rule: z.string(),
  evidence: z.array(z.string()).default([]),
  severity: z.enum(["info", "warn", "block"]).default("warn"),
});
export type Invariant = z.infer<typeof Invariant>;

export const TestRef = z.object({
  file: z.string(),
  framework: z.enum(["jest", "vitest", "pytest", "mocha", "unknown"]),
  symbols_covered: z.array(z.string()).default([]),
});
export type TestRef = z.infer<typeof TestRef>;

/* ---------- Notes & Decisions (v0.2) ---------- */

export const NoteSeverity = z.enum(["low", "medium", "high"]);
export type NoteSeverity = z.infer<typeof NoteSeverity>;

export const NoteSource = z.enum([
  "agent",
  "human",
  "doc",
  "git",
  "promoted",
  "todo",
  "pr",
  "incident",
  "transcript",
  "seed",
  "pulse",
  // Distilled from a session transcript on Stop: a lesson the agent learned, or a
  // correction/failure the user directed ("no, that's wrong", "that broke X").
  "auto-lesson",
  "user-correction",
]);
export type NoteSource = z.infer<typeof NoteSource>;

/**
 * Where a lesson lives. `symbol` is the legacy default and remains the storage
 * for `.gps/notes/{symbol}.yml`. `file`, `feature`, and `area` write to
 * dedicated subdirectories. `area` is keyed by a directory path — a location.
 * `global` lives in the CLAUDE.md `gps:global-lessons` block.
 */
export const NoteScope = z.enum(["symbol", "file", "feature", "area", "global"]);
export type NoteScope = z.infer<typeof NoteScope>;

export const ClassifierMeta = z.object({
  signals: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  used_llm: z.boolean().default(false),
  model: z.string().optional(),
  correction_kind: z.string().optional(),
});
export type ClassifierMeta = z.infer<typeof ClassifierMeta>;

export const Note = z.object({
  symbol: z.string(),
  lesson: z.string(),
  evidence: z.string().optional(),
  severity: NoteSeverity.default("medium"),
  promoted: z.boolean().default(false),
  recorded_at: z.string(),
  source: NoteSource.default("agent"),
  /** Stable identifier so a lesson can be moved between scopes by id. */
  id: z.string().optional(),
  scope: NoteScope.default("symbol"),
  /** Concrete target for the scope: symbol name, file path, or feature label. */
  applies_to: z.string().optional(),
  classifier: ClassifierMeta.optional(),
  /** Provenance: link to a PR#, commit SHA, file:line, transcript ID, or URL. */
  evidence_link: z.string().optional(),
  /** Derived confidence in this note (0..1). 1.0 = human-verified; lower = LLM-distilled. */
  confidence: z.number().min(0).max(1).optional(),
  /** Identity of human who reviewed this note (email or git username). */
  verified_by: z.string().optional(),
  verified_at: z.string().optional(),
  /** Author identity recorded at write time (git user.email when available). */
  author: z.string().optional(),
  /** Stable symbol id this note is anchored to. Survives renames/moves. */
  anchor_id: z.string().optional(),
  /** Commit SHA at note-creation time (lets us detect if anchor body changed). */
  source_commit: z.string().optional(),
  /** ISO date after which this note auto-archives. */
  expires_at: z.string().optional(),
  /** ISO timestamp this note was last surfaced to an agent (set on rank/prepare). Drives recency-based pruning. */
  last_surfaced_at: z.string().optional(),
});
export type Note = z.infer<typeof Note>;

/**
 * Schema-only in v0.2. CLI lands in v0.4 (`gps attach --session`). Defined
 * now so data collected via future channels does not need migration.
 */
export const DecisionSource = z.enum([
  "human",
  "agent",
  "transcript",
  "pr",
  "seed",
  "promoted",
]);
export type DecisionSource = z.infer<typeof DecisionSource>;

export const Decision = z.object({
  symbol: z.string(),
  decision: z.string(),
  rejected_alternative: z.string().optional(),
  rationale: z.string().optional(),
  made_by: z.string().optional(),
  session: z.string().optional(),
  recorded_at: z.string(),
  /** Stable id so the decision can be reclassified / verified by id. */
  id: z.string().optional(),
  source: DecisionSource.default("human"),
  evidence_link: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  verified_by: z.string().optional(),
  verified_at: z.string().optional(),
  anchor_id: z.string().optional(),
  source_commit: z.string().optional(),
  expires_at: z.string().optional(),
  /** ISO timestamp this decision was last surfaced to an agent. Drives recency-based pruning. */
  last_surfaced_at: z.string().optional(),
});
export type Decision = z.infer<typeof Decision>;

/* ---------- Preferences (v0.3) ---------- */

export const PreferenceScope = z.enum(["repo", "user", "global"]);
export type PreferenceScope = z.infer<typeof PreferenceScope>;

export const PreferenceSource = z.enum(["manual", "auto", "wizard"]);
export type PreferenceSource = z.infer<typeof PreferenceSource>;

export const Preference = z.object({
  id: z.string(),
  text: z.string(),
  scope: PreferenceScope.default("repo"),
  topic: z.string().optional(),
  evidence: z.string().optional(),
  source: PreferenceSource.default("manual"),
  recorded_at: z.string(),
  hits: z.number().int().nonnegative().default(0),
});
export type Preference = z.infer<typeof Preference>;

/* ---------- Capture & promotion policy (v0.5) ---------- */

/**
 * Where freshly captured memory lands.
 *   auto  — persisted live immediately (the always-on default; non-breaking).
 *   inbox — queued for human review; nothing activates until `gps inbox approve`.
 */
export const CaptureMode = z.enum(["inbox", "auto"]);
export type CaptureMode = z.infer<typeof CaptureMode>;

/**
 * Whether recurring note clusters auto-graduate into invariants.
 *   never — manual only (`gps promote <symbol>`); current behavior.
 *   safe  — auto-promote, EXCEPT clusters touching require_approval_for risk
 *           topics (auth/payments/security/…), which still need a human.
 *   all   — auto-promote everything that clusters. Visibly dangerous: bypasses
 *           the risk gate. Opt-in only.
 */
export const PromoteMode = z.enum(["never", "safe", "all"]);
export type PromoteMode = z.infer<typeof PromoteMode>;

/**
 * The governance policy persisted to `.gps/config.yml` by `gps install`.
 * Defaults are baked in here so this schema is the single source of truth:
 * `GpsPolicy.parse({})` yields the locked defaults (auto / safe).
 */
export const GpsPolicy = z.object({
  capture: CaptureMode.default("auto"),
  promote: PromoteMode.default("safe"),
  /**
   * Feature flag for hook-triggered authoring queue suggestions.
   * false — `gps suggest` remains manual only.
   * true  — supported hooks may run `gps suggest --auto` and print suggestions
   *         when high-traffic/failure symbols need notes or invariants.
   */
  auto_suggest: z.boolean().default(false),
});
export type GpsPolicy = z.infer<typeof GpsPolicy>;

export const ExperimentalFeatures = z.object({
  /**
   * Enables `gps doc --serve` / HTML live documentation. This is intentionally
   * off by default for launch: it opens a local HTTP surface and is still
   * iterating on UX, so users must opt in explicitly.
   */
  live_docs: z.boolean().default(false),
});
export type ExperimentalFeatures = z.infer<typeof ExperimentalFeatures>;

/**
 * An item queued in `.gps/inbox.yml` when `capture=inbox`. It captures the same
 * payload the always-on path would persist, but holds it for human review.
 * Approving an item runs the real persist (preference → preferences.yml,
 * directive → area note); rejected/approved items stay for an audit trail.
 */
export const InboxItemKind = z.enum(["preference", "directive"]);
export type InboxItemKind = z.infer<typeof InboxItemKind>;

export const InboxItemStatus = z.enum(["pending", "approved", "rejected"]);
export type InboxItemStatus = z.infer<typeof InboxItemStatus>;

export const InboxItem = z.object({
  /** sha1(kind + normalized text), 12 chars. Stable across edits. */
  id: z.string(),
  kind: InboxItemKind,
  text: z.string(),
  status: InboxItemStatus.default("pending"),
  captured_at: z.string(),
  /** Provenance of the capture, e.g. "cue:always" or "auto". */
  source: z.string().default("auto"),
  /** Risk topics matched at capture time (drives the red review marker). */
  risk_topics: z.array(z.string()).default([]),
  /** directive-only: polarity carried so approve can re-run the real persist. */
  polarity: z.enum(["do", "dont"]).optional(),
  /** directive-only: the resolved area (directory) the directive applies to. */
  area: z.string().optional(),
  /** preference-only: evidence string. */
  evidence: z.string().optional(),
});
export type InboxItem = z.infer<typeof InboxItem>;

/* ---------- Features (v0.4) ---------- */

export const FeatureSymbol = z.object({
  id: z.string(),
  weight: z.number().min(0).max(1),
  edits: z.number().int().nonnegative().default(0),
  reads: z.number().int().nonnegative().default(0),
  last_touched: z.string(),
  /**
   * Confidence of the most recent attribution: 1 / number_of_symbols_in_file.
   * Low values mean the file is a shared utility — the weight bump is noisy.
   */
  last_confidence: z.number().min(0).max(1).optional(),
});
export type FeatureSymbol = z.infer<typeof FeatureSymbol>;

/* ---------- Assumptions (v0.5+) ---------- */

export const AssumptionConfidence = z.enum(["low", "medium", "high"]);
export type AssumptionConfidence = z.infer<typeof AssumptionConfidence>;

export const AssumptionSource = z.enum(["agent", "human", "llm"]);
export type AssumptionSource = z.infer<typeof AssumptionSource>;

export const Assumption = z.object({
  id: z.string(),
  symbol: z.string(),
  statement: z.string(),
  confidence: AssumptionConfidence.default("medium"),
  verified: z.boolean().default(false),
  verified_at: z.string().optional(),
  evidence: z.string().optional(),
  source: AssumptionSource.default("human"),
  recorded_at: z.string(),
});
export type Assumption = z.infer<typeof Assumption>;

/* ---------- Questions (v0.5) ---------- */

export const QuestionStatus = z.enum(["unresolved", "resolved", "wontfix"]);
export type QuestionStatus = z.infer<typeof QuestionStatus>;

export const Question = z.object({
  id: z.string(),
  symbol: z.string(),
  question: z.string(),
  asked_by: z.string().optional(),
  session: z.string().optional(),
  status: QuestionStatus.default("unresolved"),
  resolution: z.string().optional(),
  recorded_at: z.string(),
  resolved_at: z.string().optional(),
});
export type Question = z.infer<typeof Question>;

export const Feature = z.object({
  label: z.string(),
  aliases: z.array(z.string()).default([]),
  symbols: z.array(FeatureSymbol).default([]),
  sessions: z.number().int().nonnegative().default(0),
  created_at: z.string(),
  last_active: z.string(),
});
export type Feature = z.infer<typeof Feature>;

/**
 * An alias is a human-friendly name ("home") that resolves to a location:
 * a file, the directory it lives in, and optionally a linked feature label.
 * Stored in the `aliases` map of `.gps/features.yml`. `source: user` bindings
 * are pinned and never overwritten by auto-learning.
 */
export const AliasBinding = z.object({
  name: z.string(),
  file: z.string().optional(),
  dir: z.string().optional(),
  feature: z.string().optional(),
  source: z.enum(["user", "auto"]).default("auto"),
  created_at: z.string(),
  last_resolved: z.string(),
  hits: z.number().int().nonnegative().default(0),
});
export type AliasBinding = z.infer<typeof AliasBinding>;

export const FeaturesFile = z.object({
  version: z.literal(1),
  features: z.record(z.string(), Feature).default({}),
  aliases: z.record(z.string(), AliasBinding).default({}),
});
export type FeaturesFile = z.infer<typeof FeaturesFile>;

/* ---------- Tool I/O ---------- */

export const Strand = z.enum(["structural", "tests", "provenance", "invariants"]);
export type Strand = z.infer<typeof Strand>;

export const ContextMode = z.enum(["brief", "full"]);
export type ContextMode = z.infer<typeof ContextMode>;

export const GetContextInput = z.object({
  symbol: z.string(),
  depth: z.number().int().min(1).max(5).default(2),
  strands: z.array(Strand).default(["structural", "tests", "provenance", "invariants"]),
  since: z.string().optional(),
  authored_by: z.string().optional(),
  mode: ContextMode.optional(),
  budget: z.number().int().nonnegative().optional(),
  /**
   * Optional ranked alternates from intent inference (Fix 2). When present and
   * the resolved symbol is weak (zero callers), a better-connected alternate is
   * surfaced as a "did you mean" hint.
   */
  candidates: z
    .array(z.object({ symbol: z.string(), score: z.number(), via: z.string() }))
    .optional(),
});
export type GetContextInput = z.infer<typeof GetContextInput>;

export const TodoItem = z.object({
  id: z.string(),
  file: z.string(),
  line: z.number().int().nonnegative().optional(),
  symbol: z.string().optional(),
  text: z.string(),
  source: z.enum(["failure", "note", "manual", "todo"]),
  created_at: z.string(),
  resolved_at: z.string().optional(),
});
export type TodoItem = z.infer<typeof TodoItem>;

/* ---------- Resolution signals (Fix 2: empty-callers confidence) ---------- */
// Kept in its own region so additive edits git-auto-merge cleanly.

/** A "you might mean X instead" hint when the resolved symbol looks weak. */
export const DidYouMeanEntry = z.object({
  symbol: z.string(),
  reason: z.string(),
});
export type DidYouMeanEntry = z.infer<typeof DidYouMeanEntry>;

/** Reusable optional fields for results that resolve a symbol. */
export const ResolutionSignalFields = {
  /** Human-readable warnings about the resolution (e.g. zero callers found). */
  resolution_warnings: z.array(z.string()).optional(),
  /** Better-connected alternatives the caller may have intended. */
  did_you_mean: z.array(DidYouMeanEntry).optional(),
} as const;

/* ---------- end resolution signals ---------- */

export const ContextResult = z.object({
  symbol: SymbolRef,
  callers: z.array(SymbolRef),
  callees: z.array(SymbolRef),
  tests: z.array(TestRef),
  provenance: z.array(ProvenanceEntry),
  invariants: z.array(Invariant),
  notes: z.array(Note).default([]),
  decisions: z.array(Decision).default([]),
  preferences: z.array(Preference).default([]),
  risk: z.enum(["low", "medium", "high"]),
  todos: z.array(TodoItem).default([]),
  truncated: z
    .object({ sections: z.array(z.string()), droppedCount: z.number().int().nonnegative() })
    .optional(),
  ...ResolutionSignalFields,
});
export type ContextResult = z.infer<typeof ContextResult>;

export const ImpactInput = z.object({
  symbol: z.string(),
  hops: z.number().int().min(1).max(5).default(3),
});
export type ImpactInput = z.infer<typeof ImpactInput>;

export const ImpactResult = z.object({
  symbol: SymbolRef,
  affected_symbols: z.array(SymbolRef),
  affected_files: z.array(z.string()),
  affected_tests: z.array(TestRef),
  blast_radius: z.number().int().nonnegative(),
});
export type ImpactResult = z.infer<typeof ImpactResult>;

/* ---------- Resolve packet (bug-resolution blast radius) ---------- */
// One target (symbol | file | commit | PR | working-tree diff) composed into a
// single decision-ready payload: forward+reverse closure, tests, applicable
// invariants, prior notes/decisions, related memory, and git/PR history.
// Kept in its own region so additive edits git-auto-merge cleanly.

export const ResolveKind = z.enum(["symbol", "file", "commit", "pr", "diff"]);
export type ResolveKind = z.infer<typeof ResolveKind>;

export const ResolveTargetSchema = z.object({
  kind: ResolveKind,
  /** Raw target: symbol name, file path, commitish, PR number, or "" for the working-tree diff. */
  value: z.string(),
});
export type ResolveTarget = z.infer<typeof ResolveTargetSchema>;

/** An invariant that applies to the change, tagged by how it reaches the target. */
export const AffectedInvariant = z.object({
  invariant: Invariant,
  /**
   * direct     — applies to a seed (the symbol/file/diff you targeted).
   * transitive — applies to a caller in the reverse blast radius.
   * dependency — applies to a callee the seed depends on.
   */
  relation: z.enum(["direct", "transitive", "dependency"]),
});
export type AffectedInvariant = z.infer<typeof AffectedInvariant>;

/** Recent commits that touched one affected file. */
export const GitHistoryEntry = z.object({
  file: z.string(),
  commits: z.array(ProvenanceEntry),
});
export type GitHistoryEntry = z.infer<typeof GitHistoryEntry>;

/** PR review context attached when the target is a PR (or an in-flight PR rides along). */
export const ResolvePrContext = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()).default([]),
  reviews: z.array(z.object({ author: z.string(), body: z.string(), state: z.string() })).default([]),
  comments: z.array(z.object({ author: z.string(), body: z.string() })).default([]),
});
export type ResolvePrContext = z.infer<typeof ResolvePrContext>;

/** A topic-matched memory artifact surfaced by recall. */
export const ResolveRecallHit = z.object({
  kind: z.string(),
  text: z.string(),
  score: z.number(),
});
export type ResolveRecallHit = z.infer<typeof ResolveRecallHit>;

export const ResolvePacketInput = z.object({
  /** Raw target string; kind is inferred unless `kind` is set. */
  target: z.string().default(""),
  /** Force the target kind instead of inferring it. */
  kind: ResolveKind.optional(),
  /** Reverse caller depth for the blast radius. */
  hops: z.number().int().min(1).max(5).default(3),
  /** Forward dependency (callee) depth. */
  depth: z.number().int().min(1).max(4).default(2),
  /** Markdown token budget (<=0 = unlimited). JSON output is never truncated. */
  budget: z.number().int().default(6000),
  /** Git log entries per affected file (0 = skip git history). */
  history: z.number().int().min(0).max(10).default(3),
});
export type ResolvePacketInput = z.infer<typeof ResolvePacketInput>;

export const ResolvePacketResult = z.object({
  target: ResolveTargetSchema,
  /** Symbols the target resolved to (the change set). */
  seeds: z.array(SymbolRef),
  /** Reverse closure: symbols that could break if the seeds change. */
  affected_symbols: z.array(SymbolRef),
  affected_files: z.array(z.string()),
  affected_tests: z.array(TestRef),
  blast_radius: z.number().int().nonnegative(),
  /** Forward closure: callees the seeds depend on. */
  dependencies: z.array(SymbolRef),
  invariants: z.array(AffectedInvariant),
  notes: z.array(Note),
  decisions: z.array(Decision),
  recall: z.array(ResolveRecallHit),
  git_history: z.array(GitHistoryEntry),
  pr: ResolvePrContext.optional(),
  /** Decision-ready brief for the primary seed (markdown). */
  prepare_markdown: z.string().optional(),
  /** Section headings dropped by the markdown budget (empty for JSON callers). */
  truncated: z.array(z.string()).default([]),
});
export type ResolvePacketResult = z.infer<typeof ResolvePacketResult>;

/* ---------- end resolve packet ---------- */

export const TestsForInput = z.object({ symbol: z.string() });
export type TestsForInput = z.infer<typeof TestsForInput>;
export const TestsForResult = z.object({ symbol: SymbolRef, tests: z.array(TestRef) });
export type TestsForResult = z.infer<typeof TestsForResult>;

export const InvariantsForInput = z.object({ symbol: z.string() });
export type InvariantsForInput = z.infer<typeof InvariantsForInput>;
export const InvariantsForResult = z.object({
  symbol: z.string(),
  invariants: z.array(Invariant),
});
export type InvariantsForResult = z.infer<typeof InvariantsForResult>;

export const RecordLearningInput = z.object({
  symbol: z.string(),
  lesson: z.string(),
  evidence: z.string().optional(),
  severity: NoteSeverity.default("medium"),
  source: NoteSource.default("agent"),
});
export type RecordLearningInput = z.infer<typeof RecordLearningInput>;
export const RecordLearningResult = z.object({
  note: Note,
  file: z.string(),
});
export type RecordLearningResult = z.infer<typeof RecordLearningResult>;

export const NotesForInput = z.object({
  symbol: z.string(),
  include_promoted: z.boolean().default(false),
});
export type NotesForInput = z.infer<typeof NotesForInput>;
export const NotesForResult = z.object({
  symbol: z.string(),
  notes: z.array(Note),
});
export type NotesForResult = z.infer<typeof NotesForResult>;

export const RecordDecisionInput = z.object({
  symbol: z.string(),
  decision: z.string(),
  rejected_alternative: z.string().optional(),
  rationale: z.string().optional(),
  made_by: z.string().optional(),
  session: z.string().optional(),
});
export type RecordDecisionInput = z.infer<typeof RecordDecisionInput>;
export const RecordDecisionResult = z.object({
  decision: Decision,
  file: z.string(),
});
export type RecordDecisionResult = z.infer<typeof RecordDecisionResult>;

export const DecisionsForInput = z.object({ symbol: z.string() });
export type DecisionsForInput = z.infer<typeof DecisionsForInput>;
export const DecisionsForResult = z.object({
  symbol: z.string(),
  decisions: z.array(Decision),
});
export type DecisionsForResult = z.infer<typeof DecisionsForResult>;

/* ---------- Lessons (v0.6 — tiered scope) ---------- */

export const RecordLessonInput = z.object({
  lesson: z.string(),
  evidence: z.string().optional(),
  severity: NoteSeverity.default("medium"),
  /** Optional scope hint. When set, classifier still runs for signals but does not override. */
  hint_scope: NoteScope.optional(),
  /** Optional target hint (symbol name, file path, feature label). */
  hint_target: z.string().optional(),
  /** Hard override: skip classification entirely. */
  force_scope: NoteScope.optional(),
  force_target: z.string().optional(),
  /** Compute classification without writing. */
  dry_run: z.boolean().default(false),
  /** Skip the LLM tie-breaker. Heuristic top label is used regardless of confidence. */
  no_llm: z.boolean().default(false),
});
export type RecordLessonInput = z.infer<typeof RecordLessonInput>;

export const RecordLessonResult = z.object({
  scope: NoteScope,
  target: z.string().optional(),
  path: z.string(),
  id: z.string(),
  signals: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  used_llm: z.boolean().default(false),
  dry_run: z.boolean().default(false),
});
export type RecordLessonResult = z.infer<typeof RecordLessonResult>;

export const LessonsListInput = z.object({
  scope: NoteScope.optional(),
  target: z.string().optional(),
});
export type LessonsListInput = z.infer<typeof LessonsListInput>;

export const LessonEntry = z.object({
  id: z.string(),
  scope: NoteScope,
  target: z.string().optional(),
  lesson: z.string(),
  severity: NoteSeverity,
  recorded_at: z.string(),
  path: z.string(),
});
export type LessonEntry = z.infer<typeof LessonEntry>;

export const LessonsListResult = z.object({
  lessons: z.array(LessonEntry),
});
export type LessonsListResult = z.infer<typeof LessonsListResult>;

export const ReclassifyLessonInput = z.object({
  id: z.string(),
  to_scope: NoteScope,
  to_target: z.string().optional(),
});
export type ReclassifyLessonInput = z.infer<typeof ReclassifyLessonInput>;

export const ReclassifyLessonResult = z.object({
  id: z.string(),
  from_scope: NoteScope,
  from_target: z.string().optional(),
  to_scope: NoteScope,
  to_target: z.string().optional(),
  path: z.string(),
});
export type ReclassifyLessonResult = z.infer<typeof ReclassifyLessonResult>;

/* ---------- Directives: location-scoped instructions (v0.8) ---------- */

export const RecordDirectiveInput = z.object({
  directive: z.string().describe(
    "The location-scoped instruction, e.g. \"don't use inline styles here\".",
  ),
  polarity: z.enum(["do", "dont"]).optional().describe(
    "Whether this is a do/avoid directive. Auto-detected from phrasing if omitted.",
  ),
  area: z.string().optional().describe(
    "Directory path or alias name. Defaults to the active area (resolved from the active feature's bound alias, or the most recently edited file's directory).",
  ),
  alias: z.string().optional().describe(
    "Bind/learn this human-friendly name for the area (e.g. \"home\").",
  ),
  evidence: z.string().optional(),
  severity: NoteSeverity.default("medium"),
});
export type RecordDirectiveInput = z.infer<typeof RecordDirectiveInput>;

export const RecordDirectiveResult = z.object({
  scope: z.literal("area"),
  area: z.string(),
  alias: z.string().optional(),
  id: z.string(),
  path: z.string(),
  polarity: z.enum(["do", "dont"]),
});
export type RecordDirectiveResult = z.infer<typeof RecordDirectiveResult>;

export const SuggestInput = z.object({
  min_count: z.number().int().min(1).default(3),
  limit: z.number().int().min(1).max(100).default(10),
});
export type SuggestInput = z.infer<typeof SuggestInput>;
export const Suggestion = z.object({
  symbol: z.string(),
  count: z.number().int().nonnegative(),
  last_queried: z.string(),
  reason: z.enum(["no_invariant", "no_note", "high_traffic"]),
});
export type Suggestion = z.infer<typeof Suggestion>;
export const SuggestResult = z.object({
  suggestions: z.array(Suggestion),
});
export type SuggestResult = z.infer<typeof SuggestResult>;

export const FindReusableInput = z.object({
  query: z.string(),
  kind: SymbolKind.optional(),
  limit: z.number().int().min(1).max(50).default(10),
});
export type FindReusableInput = z.infer<typeof FindReusableInput>;
export const FindReusableResult = z.object({
  candidates: z.array(z.object({ symbol: SymbolRef, score: z.number() })),
});
export type FindReusableResult = z.infer<typeof FindReusableResult>;

/**
 * Meta-tool: agent calls this with a symbol it's about to edit and a short
 * description. We return a single decision-ready brief (structural + tests +
 * invariants + risk) optimised for the LLM, not for chaining.
 */
export const PrepareEditInput = z.object({
  symbol: z.string().optional().describe(
    "Symbol to prepare. Optional if `intent` is provided — GPS will infer the top-matching symbol from the intent text.",
  ),
  intent: z.string().describe("What the agent plans to change, in one sentence."),
  budget: z.number().int().positive().optional().describe(
    "Optional token budget; sections are dropped tail-first when exceeded.",
  ),
  since: z.string().optional().describe(
    "ISO date or relative like '7d'/'2w'/'3mo'; drops notes/decisions/questions older than this.",
  ),
  depth: z.number().int().min(1).max(3).optional().describe(
    "Neighborhood depth for callee context (1 = symbol only).",
  ),
  /**
   * Optional ranked alternates from intent inference (Fix 2). When present and
   * the resolved symbol is weak (zero callers), a better-connected alternate is
   * surfaced as a "did you mean" hint.
   */
  candidates: z
    .array(z.object({ symbol: z.string(), score: z.number(), via: z.string() }))
    .optional(),
});
export type PrepareEditInput = z.infer<typeof PrepareEditInput>;

/**
 * Versioned result so downstream tooling (CI, IDE plugins) can pin against a
 * known shape. Bump the literal when the result fields change.
 */
export const PREPARE_EDIT_SCHEMA_VERSION = 1 as const;
export const PrepareEditResult = z.object({
  schema_version: z.literal(PREPARE_EDIT_SCHEMA_VERSION).default(PREPARE_EDIT_SCHEMA_VERSION),
  markdown: z.string(),
  invariants_to_respect: z.array(Invariant),
  notes: z.array(Note).default([]),
  decisions: z.array(Decision).default([]),
  preferences: z.array(Preference).default([]),
  tests_to_run: z.array(z.string()),
  risk: z.enum(["low", "medium", "high"]),
  /** When `symbol` was inferred from intent, the ranked alternates. */
  candidates: z
    .array(z.object({ symbol: z.string(), score: z.number(), via: z.string() }))
    .optional(),
  ...ResolutionSignalFields,
});
export type PrepareEditResult = z.infer<typeof PrepareEditResult>;

/* ---------- Pulse: diff-time risk (v0.7) ---------- */

export const PulseSeverity = z.enum(["info", "low", "medium", "high", "block"]);
export type PulseSeverity = z.infer<typeof PulseSeverity>;

export const PulseFinding = z.object({
  kind: z.enum([
    "invariant_hit",
    "untested_caller",
    "note_ignored",
    "decision_contradicted",
    "stale_note",
  ]),
  severity: PulseSeverity,
  symbol: z.string().optional(),
  file: z.string().optional(),
  message: z.string(),
  evidence: z.string().optional(),
});
export type PulseFinding = z.infer<typeof PulseFinding>;

export const PulseInput = z.object({
  base: z.string().default("HEAD"),
  files: z.array(z.string()).optional(),
  /** Output format: markdown | json | github (PR comment body). */
  format: z.enum(["markdown", "json", "github"]).default("markdown"),
});
export type PulseInput = z.infer<typeof PulseInput>;

export const PulseResult = z.object({
  base: z.string(),
  changed_files: z.array(z.string()),
  changed_symbols: z.array(z.string()),
  findings: z.array(PulseFinding),
  risk_score: z.number().min(0).max(1),
  risk_band: z.enum(["low", "medium", "high", "block"]),
  markdown: z.string(),
});
export type PulseResult = z.infer<typeof PulseResult>;

/* ---------- Seed: cold-start bootstrap (v0.7) ---------- */

export const SeedProposal = z.object({
  kind: z.enum(["note", "decision", "invariant"]),
  symbol: z.string().optional(),
  applies_to: z.array(z.string()).default([]),
  text: z.string(),
  evidence_link: z.string().optional(),
  source: z.enum(["pr", "git", "incident", "todo"]),
  confidence: z.number().min(0).max(1),
});
export type SeedProposal = z.infer<typeof SeedProposal>;

export const SeedResult = z.object({
  proposals: z.array(SeedProposal),
  scanned: z.object({
    commits: z.number().int().nonnegative(),
    prs: z.number().int().nonnegative(),
    todos: z.number().int().nonnegative(),
  }),
});
export type SeedResult = z.infer<typeof SeedResult>;

/* ---------- v0.7: governance + memory MCP surface ---------- */

export const GateCheckInput = z.object({
  base: z.string().optional().describe("Git base ref to diff against (default: HEAD)."),
  files: z.array(z.string()).optional().describe("Override the changed-file set (e.g. when no git diff exists)."),
});
export type GateCheckInput = z.infer<typeof GateCheckInput>;

export const GateHitOut = z.object({
  invariant: Invariant,
  symbols: z.array(z.string()),
  files: z.array(z.string()),
  waived: z.boolean(),
});
export const GateCheckResult = z.object({
  base: z.string(),
  changed_files: z.array(z.string()),
  changed_symbols: z.array(z.string()),
  hits: z.array(GateHitOut),
  blocking: z.array(GateHitOut),
});
export type GateCheckResult = z.infer<typeof GateCheckResult>;

export const AuditSessionInput = z.object({});
export type AuditSessionInput = z.infer<typeof AuditSessionInput>;
export const AuditCheckOut = z.object({
  id: z.string(),
  pass: z.boolean(),
  detail: z.string(),
});
export const AuditSessionResult = z.object({
  session: z.string().optional(),
  events: z.number().int().nonnegative(),
  checks: z.array(AuditCheckOut),
});
export type AuditSessionResult = z.infer<typeof AuditSessionResult>;

export const FeatureHealthInput = z.object({
  feature: z.string().optional().describe("Feature label. Omit for all features."),
});
export type FeatureHealthInput = z.infer<typeof FeatureHealthInput>;
export const FeatureHealthOut = z.object({
  feature: z.string(),
  symbols: z.number().int().nonnegative(),
  invariants: z.number().int().nonnegative(),
  notes: z.number().int().nonnegative(),
  notes_stale: z.number().int().nonnegative(),
  decisions: z.number().int().nonnegative(),
  open_questions: z.number().int().nonnegative(),
  open_questions_old: z.number().int().nonnegative(),
  assumptions: z.number().int().nonnegative(),
  unverified_assumptions: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  score: z.number(),
  last_active: z.string(),
});
export const FeatureHealthResult = z.object({
  features: z.array(FeatureHealthOut),
});
export type FeatureHealthResult = z.infer<typeof FeatureHealthResult>;

export const FindConflictsInput = z.object({ symbol: z.string() });
export type FindConflictsInput = z.infer<typeof FindConflictsInput>;
export const ConflictOut = z.object({
  kind: z.enum(["contradicts", "supersedes", "stale"]),
  symbol: z.string(),
  lhs: z.object({
    type: z.enum(["invariant", "decision", "note"]),
    id: z.string(),
    text: z.string(),
    at: z.string().optional(),
  }),
  rhs: z.object({
    type: z.enum(["invariant", "decision", "note"]),
    id: z.string(),
    text: z.string(),
    at: z.string().optional(),
  }),
  summary: z.string(),
});
export const FindConflictsResult = z.object({
  symbol: z.string(),
  conflicts: z.array(ConflictOut),
});
export type FindConflictsResult = z.infer<typeof FindConflictsResult>;

export const FindStaleInput = z.object({
  days: z.number().int().min(1).default(90),
  feature: z.string().optional(),
});
export type FindStaleInput = z.infer<typeof FindStaleInput>;
export const StaleEntryOut = z.object({
  kind: z.enum(["note", "decision", "question"]),
  symbol: z.string(),
  age_days: z.number().int().nonnegative(),
  file: z.string().optional(),
  file_changed_since: z.boolean(),
  text: z.string(),
});
export const FindStaleResult = z.object({
  entries: z.array(StaleEntryOut),
});
export type FindStaleResult = z.infer<typeof FindStaleResult>;

export const RecordQuestionInput = z.object({
  symbol: z.string(),
  question: z.string(),
  asked_by: z.string().optional(),
  session: z.string().optional(),
});
export type RecordQuestionInput = z.infer<typeof RecordQuestionInput>;
export const RecordQuestionResult = z.object({
  question: Question,
  file: z.string(),
});
export type RecordQuestionResult = z.infer<typeof RecordQuestionResult>;

export const QuestionsForInput = z.object({
  symbol: z.string().optional(),
  status: QuestionStatus.optional(),
});
export type QuestionsForInput = z.infer<typeof QuestionsForInput>;
export const QuestionsForResult = z.object({
  questions: z.array(Question),
});
export type QuestionsForResult = z.infer<typeof QuestionsForResult>;

export const ResolveQuestionInput = z.object({
  symbol: z.string(),
  id: z.string(),
  status: QuestionStatus,
  resolution: z.string().optional(),
});
export type ResolveQuestionInput = z.infer<typeof ResolveQuestionInput>;
export const ResolveQuestionResult = z.object({
  question: Question.optional(),
});
export type ResolveQuestionResult = z.infer<typeof ResolveQuestionResult>;

export const RecordAssumptionInput = z.object({
  symbol: z.string(),
  statement: z.string(),
  confidence: AssumptionConfidence.optional(),
  evidence: z.string().optional(),
  source: AssumptionSource.optional(),
});
export type RecordAssumptionInput = z.infer<typeof RecordAssumptionInput>;
export const RecordAssumptionResult = z.object({
  assumption: Assumption,
  file: z.string(),
});
export type RecordAssumptionResult = z.infer<typeof RecordAssumptionResult>;

export const AssumptionsForInput = z.object({ symbol: z.string() });
export type AssumptionsForInput = z.infer<typeof AssumptionsForInput>;
export const AssumptionsForResult = z.object({
  symbol: z.string(),
  assumptions: z.array(Assumption),
});
export type AssumptionsForResult = z.infer<typeof AssumptionsForResult>;

export const ContributorsForInput = z.object({ symbol: z.string() });
export type ContributorsForInput = z.infer<typeof ContributorsForInput>;
export const ContributorOut = z.object({
  name: z.string(),
  score: z.number(),
  commits: z.number().int().nonnegative(),
  decisions: z.number().int().nonnegative(),
});
export const ContributorsForResult = z.object({
  symbol: z.string(),
  contributors: z.array(ContributorOut),
});
export type ContributorsForResult = z.infer<typeof ContributorsForResult>;

export const RecordPreferenceInput = z.object({
  text: z.string(),
  scope: PreferenceScope.optional(),
  topic: z.string().optional(),
  evidence: z.string().optional(),
});
export type RecordPreferenceInput = z.infer<typeof RecordPreferenceInput>;
export const RecordPreferenceResult = z.object({
  preference: Preference,
  file: z.string(),
  deduped: z.boolean(),
});
export type RecordPreferenceResult = z.infer<typeof RecordPreferenceResult>;

export const PreferencesListInput = z.object({});
export type PreferencesListInput = z.infer<typeof PreferencesListInput>;
export const PreferencesListResult = z.object({
  preferences: z.array(Preference),
});
export type PreferencesListResult = z.infer<typeof PreferencesListResult>;

export const BuildContractInput = z.object({
  symbol: z.string(),
  intent: z.string().optional(),
  save: z.boolean().default(true).describe("Persist to .gps/contract.json for later verify_contract."),
});
export type BuildContractInput = z.infer<typeof BuildContractInput>;
export const EditContractOut = z.object({
  symbol: z.string(),
  intent: z.string(),
  created_at: z.string(),
  allowed_files: z.array(z.string()),
  allowed_symbols: z.array(z.string()),
  invariants: z.array(Invariant),
  required_tests: z.array(z.string()),
  risky_callers: z.array(z.string()),
  blockers: z.array(z.string()),
});
export const BuildContractResult = z.object({
  contract: EditContractOut,
  saved: z.boolean(),
});
export type BuildContractResult = z.infer<typeof BuildContractResult>;

export const VerifyContractInput = z.object({
  base: z.string().default("HEAD"),
});
export type VerifyContractInput = z.infer<typeof VerifyContractInput>;
export const ContractViolationOut = z.object({
  type: z.enum(["out-of-scope-file", "out-of-scope-symbol", "blocker-untouched"]),
  detail: z.string(),
});
export const VerifyContractResult = z.object({
  contract: EditContractOut.optional(),
  diff_files: z.array(z.string()).default([]),
  diff_symbols: z.array(z.string()).default([]),
  violations: z.array(ContractViolationOut).default([]),
});
export type VerifyContractResult = z.infer<typeof VerifyContractResult>;

export const CheckProposalInput = z.object({
  symbol: z.string().optional(),
  proposal: z.string(),
  threshold: z.number().min(0).max(1).default(0.25),
  limit: z.number().int().min(1).max(50).default(5),
});
export type CheckProposalInput = z.infer<typeof CheckProposalInput>;
export const RejectedConflictOut = z.object({
  symbol: z.string(),
  proposed: z.string(),
  rejected_alternative: z.string(),
  prior_decision: z.string(),
  rationale: z.string().optional(),
  recorded_at: z.string(),
  similarity: z.number(),
});
export const CheckProposalResult = z.object({
  matches: z.array(RejectedConflictOut),
});
export type CheckProposalResult = z.infer<typeof CheckProposalResult>;

export const PromotionCandidatesInput = z.object({
  symbol: z.string(),
  min_occurrences: z.number().int().min(2).default(3),
  threshold: z.number().min(0).max(1).default(0.4),
});
export type PromotionCandidatesInput = z.infer<typeof PromotionCandidatesInput>;
export const PromotionCandidateOut = z.object({
  symbol: z.string(),
  representative_lesson: z.string(),
  notes: z.array(Note),
  severity_hint: z.enum(["info", "warn", "block"]),
});
export const PromotionCandidatesResult = z.object({
  candidates: z.array(PromotionCandidateOut),
});
export type PromotionCandidatesResult = z.infer<typeof PromotionCandidatesResult>;

/* ---------- validate_knowledge (P3) ---------- */

export const ValidateKnowledgeInput = z.object({});
export type ValidateKnowledgeInput = z.infer<typeof ValidateKnowledgeInput>;

export const KnowledgeIssue = z.object({
  kind: z.enum(["missing_anchor", "expired", "no_anchor_id"]),
  source: z.enum(["note", "decision", "invariant"]),
  entry: z.object({
    symbol: z.string().optional(),
    anchor_id: z.string().optional(),
    summary: z.string(),
  }),
  suggested_anchor: z.object({
    symbol_id: z.string(),
    qualified_name: z.string(),
    file: z.string(),
    score: z.number(),
  }).optional(),
});

export const ValidateKnowledgeResult = z.object({
  total: z.object({
    notes: z.number().int().nonnegative(),
    decisions: z.number().int().nonnegative(),
    invariants: z.number().int().nonnegative(),
  }),
  issues: z.array(KnowledgeIssue),
});
export type ValidateKnowledgeResult = z.infer<typeof ValidateKnowledgeResult>;

/* ---------- seed_propose (P1.5) ---------- */

export const SeedProposeInput = z.object({
  tier: z.enum(["safe", "medium", "aggressive"]).default("safe"),
  limit: z.number().int().positive().optional(),
});
export type SeedProposeInput = z.infer<typeof SeedProposeInput>;

export const SeedProposeResult = z.object({
  tier: z.string(),
  proposals: z.array(z.any()),
  scanned: z.object({
    commits: z.number().int().nonnegative(),
    prs: z.number().int().nonnegative(),
    todos: z.number().int().nonnegative(),
  }),
});
export type SeedProposeResult = z.infer<typeof SeedProposeResult>;

/* ---------- gate_stream / review_diff (P2) ---------- */

export const GateStreamInput = z.object({
  /** Preferred cursor: return entries with seq > since_seq. */
  since_seq: z.number().int().nonnegative().optional(),
  /** Backwards-compat cursor: ISO timestamp. Ignored if since_seq is set. */
  since: z.string().optional(),
  limit: z.number().int().positive().optional(),
});
export type GateStreamInput = z.infer<typeof GateStreamInput>;

export const GateStreamEntry = z.object({
  /** Monotonic per-file counter; use as cursor for the next call. */
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  changed_files: z.array(z.string()),
  changed_symbols: z.array(z.string()),
  hits: z.array(z.any()),
  blocking: z.array(z.any()),
});
export const GateStreamResult = z.object({
  entries: z.array(GateStreamEntry),
});
export type GateStreamResult = z.infer<typeof GateStreamResult>;

export const ReviewDiffInput = z.object({
  base: z.string().optional(),
});
export type ReviewDiffInput = z.infer<typeof ReviewDiffInput>;

export const ReviewDiffResult = z.object({
  base: z.string(),
  changed_files: z.array(z.string()),
  changed_symbols: z.array(z.string()),
  hits: z.array(z.any()),
  blocking: z.array(z.any()),
});
export type ReviewDiffResult = z.infer<typeof ReviewDiffResult>;

export const ReviewMemoryInput = z.object({
  days: z.number().int().min(1).default(90),
  limit: z.number().int().positive().default(25),
});
export type ReviewMemoryInput = z.infer<typeof ReviewMemoryInput>;

export const ReviewMemoryAction = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("promotion_candidates"),
    args: z.object({ symbol: z.string() }),
  }),
  z.object({
    tool: z.literal("find_stale"),
    args: z.object({ days: z.number().int().min(1) }),
  }),
  z.object({
    tool: z.literal("questions_for"),
    args: z.object({
      symbol: z.string(),
      status: z.literal("unresolved"),
    }),
  }),
]);
export type ReviewMemoryAction = z.infer<typeof ReviewMemoryAction>;

export const ReviewMemoryItem = z.object({
  kind: z.enum(["promote", "stale", "open_question"]),
  priority: z.enum(["high", "medium", "low"]),
  symbol: z.string(),
  age_days: z.number().int().nonnegative().optional(),
  reason: z.string(),
  command: z.string(),
  action: ReviewMemoryAction,
});
export type ReviewMemoryItem = z.infer<typeof ReviewMemoryItem>;

export const ReviewMemoryResult = z.object({
  promote: z.array(PromotionCandidateOut),
  stale: z.array(StaleEntryOut),
  open_questions: z.array(z.object({
    id: z.string(),
    symbol: z.string(),
    question: z.string(),
    age_days: z.number().int().nonnegative(),
  })),
  items: z.array(ReviewMemoryItem),
  total: z.number().int().nonnegative(),
});
export type ReviewMemoryResult = z.infer<typeof ReviewMemoryResult>;

/* ---------- verify_index (P0c) ---------- */

export const VerifyIndexInput = z.object({
  sample: z.number().int().positive().optional(),
});
export type VerifyIndexInput = z.infer<typeof VerifyIndexInput>;

export const VerifyIndexWorst = z.object({
  from_file: z.string(),
  from_line: z.number().int().nonnegative(),
  callee: z.string(),
  gps_resolved_to: z.string().optional(),
  ts_resolved_to: z.string().optional(),
  issue: z.enum(["wrong_target", "ts_says_no_target", "gps_missed"]),
});

export const VerifyIndexResult = z.object({
  language: z.enum(["typescript"]),
  sample_size: z.number().int().nonnegative(),
  total_edges: z.number().int().nonnegative(),
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1),
  coverage: z.number().min(0).max(1),
  worst: z.array(VerifyIndexWorst),
});
export type VerifyIndexResult = z.infer<typeof VerifyIndexResult>;

/* ---------- Brief (pre-finalize briefing) ---------- */

export const BriefInput = z.object({
  base: z.string().optional(),
  max_symbols: z.number().int().min(1).max(200).optional(),
});
export type BriefInput = z.infer<typeof BriefInput>;

export const BriefGateHit = z.object({
  invariant: Invariant,
  symbols: z.array(z.string()),
  files: z.array(z.string()),
  waived: z.boolean(),
});

export const BriefNoteEntry = z.object({
  scope: z.enum(["symbol", "file", "area"]),
  target: z.string(),
  notes: z.array(Note),
});

export const BriefSymbolEntry = z.object({
  symbol: SymbolRef,
  tests: z.array(TestRef),
  questions: z.array(Question),
});

export const ChangeCommit = z.object({
  sha: z.string(),
  author: z.string(),
  date: z.string(),
  message: z.string(),
  pr: z.number().int().positive().optional(),
});
export type ChangeCommit = z.infer<typeof ChangeCommit>;

export const ChangeFileEntry = z.object({
  file: z.string(),
  symbols: z.array(SymbolRef),
});
export type ChangeFileEntry = z.infer<typeof ChangeFileEntry>;

export const ChangeSummary = z.object({
  base: z.string(),
  source: z.enum(["diff", "pr"]),
  pr: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
  }).optional(),
  changed_files: z.array(z.string()),
  changed_symbols: z.array(SymbolRef),
  files: z.array(ChangeFileEntry),
  commits: z.array(ChangeCommit),
  prs: z.array(z.number().int().positive()),
});
export type ChangeSummary = z.infer<typeof ChangeSummary>;

export const ChangeSummaryInput = z.object({
  base: z.string().optional().describe("Git base ref to diff against (default: HEAD)."),
  head: z.string().optional().describe("Commit-range head for provenance (default: HEAD)."),
  pr: z.union([z.number().int().positive(), z.string()]).optional().describe("GitHub PR number to summarize instead of the working tree."),
  max_commits: z.number().int().min(1).max(100).optional(),
});
export type ChangeSummaryInput = z.infer<typeof ChangeSummaryInput>;

export const AgentFrictionSuggestion = z.object({
  kind: z.enum(["hard_search"]),
  symbol: z.string().optional(),
  file: z.string().optional(),
  command_count: z.number().int().nonnegative(),
  why: z.string(),
  remember_command: z.string(),
  next_time_command: z.string().optional(),
  suggestion: z.string(),
});
export type AgentFrictionSuggestion = z.infer<typeof AgentFrictionSuggestion>;

export const BriefResult = z.object({
  base: z.string(),
  changed_files: z.array(z.string()),
  changed_symbols: z.array(SymbolRef),
  changes: ChangeSummary,
  invariants: z.object({
    hits: z.array(BriefGateHit),
    blocking_count: z.number().int().nonnegative(),
  }),
  notes: z.array(BriefNoteEntry),
  per_symbol: z.array(BriefSymbolEntry),
  untested_symbols: z.array(z.string()),
  truncated: z.boolean(),
  /** True when at least one indexed source symbol changed. False when only config/docs/non-indexed files changed. */
  source_changes: z.boolean(),
  /** MCP-only closeout nudge for costly search loops observed in the active session. */
  agent_friction_suggestions: z.array(AgentFrictionSuggestion).optional(),
});
export type BriefResult = z.infer<typeof BriefResult>;

export const MemorySuggestionRememberAction = z.object({
  tool: z.literal("record_learning"),
  fact: z.string(),
  scope: z.literal("symbol"),
  target: z.string(),
  evidence: z.string().optional(),
});
export type MemorySuggestionRememberAction = z.infer<typeof MemorySuggestionRememberAction>;

export const MemorySuggestionAction = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("record_lesson"),
    args: z.object({
      lesson: z.string(),
      force_scope: z.literal("symbol"),
      force_target: z.string(),
      evidence: z.string().optional(),
    }),
  }),
  z.object({
    tool: z.literal("questions_for"),
    args: z.object({
      symbol: z.string(),
      status: z.literal("unresolved"),
    }),
  }),
  z.object({
    tool: z.literal("assumptions_for"),
    args: z.object({
      symbol: z.string(),
    }),
  }),
  z.object({
    tool: z.literal("list_todos"),
    args: z.object({
      symbol: z.string(),
      include_resolved: z.literal(false),
    }),
  }),
]);
export type MemorySuggestionAction = z.infer<typeof MemorySuggestionAction>;

export const MemorySuggestion = z.object({
  kind: z.enum(["record_symbol_memory", "answer_question", "verify_assumption", "resolve_todo"]),
  symbol: z.string(),
  file: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  reason: z.string(),
  command: z.string(),
  action: MemorySuggestionAction.optional(),
  remember: MemorySuggestionRememberAction.optional(),
});
export type MemorySuggestion = z.infer<typeof MemorySuggestion>;

export const MemorySuggestionsInput = z.object({
  base: z.string().optional(),
  pr: z.union([z.number().int().positive(), z.string()]).optional(),
  limit: z.number().int().positive().optional(),
  evidence: z.string().optional(),
  apply: z.boolean().optional(),
});
export type MemorySuggestionsInput = z.infer<typeof MemorySuggestionsInput>;

export const AppliedMemorySuggestion = z.object({
  suggestion: MemorySuggestion,
  result: z.object({
    id: z.string(),
    scope: NoteScope,
    target: z.string().optional(),
    path: z.string(),
    promoted: z.boolean().optional(),
    pending_count: z.number().int().nonnegative().optional(),
  }),
});
export type AppliedMemorySuggestion = z.infer<typeof AppliedMemorySuggestion>;

export const ApplyMemorySuggestionsResult = z.object({
  applied: z.array(AppliedMemorySuggestion),
  skipped: z.array(MemorySuggestion),
});
export type ApplyMemorySuggestionsResult = z.infer<typeof ApplyMemorySuggestionsResult>;

export const MemorySuggestionsResult = z.object({
  base: z.string(),
  source: z.enum(["diff", "pr"]),
  pr: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    files: z.array(z.string()),
  }).optional(),
  changed_files: z.array(z.string()),
  changed_symbol_count: z.number().int().nonnegative(),
  changed_symbols: z.array(z.string()),
  suggestions: z.array(MemorySuggestion),
  application: ApplyMemorySuggestionsResult.optional(),
});
export type MemorySuggestionsResult = z.infer<typeof MemorySuggestionsResult>;

export const MemoryHealthInput = z.object({
  days: z.number().int().min(1).default(90),
  limit: z.number().int().positive().default(10),
  base: z.string().optional(),
  include_diff: z.boolean().optional(),
});
export type MemoryHealthInput = z.infer<typeof MemoryHealthInput>;

export const MemoryHealthCounts = z.object({
  symbol_notes: z.number().int().nonnegative(),
  scoped_notes: z.number().int().nonnegative(),
  decisions: z.number().int().nonnegative(),
  invariants: z.number().int().nonnegative(),
  preferences: z.number().int().nonnegative(),
  inbox_pending: z.number().int().nonnegative(),
  review_items: z.number().int().nonnegative(),
  validation_issues: z.number().int().nonnegative(),
  prunable: z.number().int().nonnegative(),
  diff_suggestions: z.number().int().nonnegative(),
});
export type MemoryHealthCounts = z.infer<typeof MemoryHealthCounts>;

export const MemoryHealthAction = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("review_memory"),
    args: z.object({ days: z.number().int().min(1), limit: z.number().int().positive() }),
  }),
  z.object({
    tool: z.literal("validate_knowledge"),
    args: z.object({}),
  }),
  z.object({
    tool: z.literal("prune"),
    args: z.object({ days: z.number().int().min(1), dry_run: z.literal(true) }),
  }),
  z.object({
    tool: z.literal("memory_suggestions"),
    args: z.object({ base: z.string(), limit: z.number().int().positive() }),
  }),
]);
export type MemoryHealthAction = z.infer<typeof MemoryHealthAction>;

export const MemoryHealthRecommendation = z.object({
  kind: z.enum(["review_memory", "validate_knowledge", "prune", "memory_suggestions"]),
  priority: z.enum(["high", "medium", "low"]),
  reason: z.string(),
  command: z.string(),
  action: MemoryHealthAction,
});
export type MemoryHealthRecommendation = z.infer<typeof MemoryHealthRecommendation>;

export const MemoryHealthResult = z.object({
  status: z.enum(["healthy", "watch", "needs_attention"]),
  score: z.number().min(0).max(1),
  counts: MemoryHealthCounts,
  recommendations: z.array(MemoryHealthRecommendation),
  review_items: z.array(ReviewMemoryItem),
});
export type MemoryHealthResult = z.infer<typeof MemoryHealthResult>;

/**
 * Tool catalogue — referenced by CLI command registration and MCP server
 * registration so the surfaces cannot drift.
 */
/* ---------- Prune + Resume I/O (v0.9) ---------- */

export const PruneInput = z.object({
  days: z.number().int().min(1).default(90).describe(
    "Notes unsurfaced (or never surfaced) for this many days are candidates for pruning.",
  ),
  min_confidence: z.number().min(0).max(1).default(0.8).describe(
    "Keep memories at or above this confidence threshold.",
  ),
  auto: z.boolean().default(false).describe(
    "Background mode: skip the prune if the interval has not elapsed.",
  ),
  interval_days: z.number().int().min(1).default(7).describe(
    "Minimum days between background prune runs.",
  ),
  dry_run: z.boolean().default(false).describe("Print what would be removed without writing."),
});
export type PruneInput = z.infer<typeof PruneInput>;

export const PruneResult = z.object({
  removed: z.number().int().nonnegative(),
  dry_run: z.boolean(),
  details: z.array(z.object({
    kind: z.enum(["note", "decision"]),
    symbol: z.string(),
    text: z.string(),
    reason: z.string(),
    file: z.string(),
  })),
});
export type PruneResult = z.infer<typeof PruneResult>;

export const ResumeInput = z.object({});
export type ResumeInput = z.infer<typeof ResumeInput>;

export const ResumeResult = z.object({
  todos: z.array(TodoItem),
  questions: z.array(Question),
  decisions: z.array(Decision),
  changed_files: z.array(z.string()),
  markdown: z.string(),
});
export type ResumeResult = z.infer<typeof ResumeResult>;

export const RecallKind = z.enum(["note", "decision", "invariant", "preference", "lesson", "question", "assumption", "todo"]);
export type RecallKind = z.infer<typeof RecallKind>;

export const RecallMemoryInput = z.object({
  query: z.string(),
  limit: z.number().int().positive().optional(),
  kinds: z.array(RecallKind).optional(),
  related: z.boolean().optional(),
  related_limit: z.number().int().positive().optional(),
});
export type RecallMemoryInput = z.infer<typeof RecallMemoryInput>;

export const RecallRelatedSymbol = z.object({
  symbol: z.string(),
  file: z.string(),
  line: z.number().int().nonnegative(),
  relation: z.enum(["anchor", "caller", "callee"]),
});
export type RecallRelatedSymbol = z.infer<typeof RecallRelatedSymbol>;

export const RecallHit = z.object({
  kind: RecallKind,
  text: z.string(),
  anchor: z.string().optional(),
  score: z.number(),
  severity: z.string().optional(),
  source: z.string().optional(),
  related_symbols: z.array(RecallRelatedSymbol).optional(),
});
export type RecallHit = z.infer<typeof RecallHit>;

export const RecallMemoryResult = z.object({
  query: z.string(),
  hits: z.array(RecallHit),
});
export type RecallMemoryResult = z.infer<typeof RecallMemoryResult>;

export const MemoryGraphInput = z.object({
  query: z.string(),
  limit: z.number().int().positive().optional(),
  kinds: z.array(RecallKind).optional(),
  related_limit: z.number().int().positive().optional(),
  include_symbols: z.boolean().optional(),
  symbol_limit: z.number().int().positive().optional(),
  include_issues: z.boolean().optional(),
  stale_days: z.number().int().nonnegative().optional(),
});
export type MemoryGraphInput = z.infer<typeof MemoryGraphInput>;

export const MemoryGraphNode = z.object({
  id: z.string(),
  type: z.enum(["memory", "symbol"]),
  label: z.string(),
  kind: z.string().optional(),
  text: z.string().optional(),
  anchor: z.string().optional(),
  score: z.number().optional(),
  file: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
});
export type MemoryGraphNode = z.infer<typeof MemoryGraphNode>;

export const MemoryGraphEdge = z.object({
  from: z.string(),
  to: z.string(),
  type: z.enum(["anchors", "calls", "related", "same_anchor", "shares_symbol"]),
});
export type MemoryGraphEdge = z.infer<typeof MemoryGraphEdge>;

export const MemoryGraphIssue = z.object({
  kind: z.enum(["conflict", "stale", "orphan_anchor", "promotion_candidate", "open_question", "unverified_assumption", "open_todo", "memory_gap"]),
  symbol: z.string(),
  summary: z.string(),
  severity: z.enum(["info", "warn", "block"]),
  command: z.string(),
});
export type MemoryGraphIssue = z.infer<typeof MemoryGraphIssue>;

export const MemoryGraphCentralSymbol = z.object({
  symbol: z.string(),
  file: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  degree: z.number().int().nonnegative(),
  memory_count: z.number().int().nonnegative(),
  issue_count: z.number().int().nonnegative(),
});
export type MemoryGraphCentralSymbol = z.infer<typeof MemoryGraphCentralSymbol>;

export const MemoryGraphSummary = z.object({
  memory_nodes: z.number().int().nonnegative(),
  symbol_nodes: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  issues: z.object({
    total: z.number().int().nonnegative(),
    block: z.number().int().nonnegative(),
    warn: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
  }),
  central_symbols: z.array(MemoryGraphCentralSymbol),
});
export type MemoryGraphSummary = z.infer<typeof MemoryGraphSummary>;

export const MemoryGraphRecommendation = z.object({
  kind: z.enum(["resolve_issue", "answer_question", "verify_assumption", "resolve_todo", "promote_memory", "inspect_symbol", "record_memory"]),
  priority: z.enum(["high", "medium", "low"]),
  command: z.string(),
  reason: z.string(),
  action: z.discriminatedUnion("tool", [
    z.object({
      tool: z.literal("prepare_edit"),
      args: z.object({ symbol: z.string(), intent: z.string().optional() }),
    }),
    z.object({
      tool: z.literal("record_lesson"),
      args: z.object({
        lesson: z.string(),
        force_scope: z.literal("symbol").optional(),
        force_target: z.string().optional(),
        evidence: z.string().optional(),
      }),
    }),
    z.object({
      tool: z.literal("questions_for"),
      args: z.object({ symbol: z.string(), status: z.literal("unresolved") }),
    }),
    z.object({
      tool: z.literal("assumptions_for"),
      args: z.object({ symbol: z.string() }),
    }),
    z.object({
      tool: z.literal("list_todos"),
      args: z.object({ symbol: z.string(), include_resolved: z.literal(false) }),
    }),
    z.object({
      tool: z.literal("promotion_candidates"),
      args: z.object({ symbol: z.string() }),
    }),
    z.object({
      tool: z.literal("find_conflicts"),
      args: z.object({ symbol: z.string() }),
    }),
    z.object({
      tool: z.literal("find_stale"),
      args: z.object({ days: z.number().int().min(1) }),
    }),
    z.object({
      tool: z.literal("validate_knowledge"),
      args: z.object({}),
    }),
  ]).optional(),
});
export type MemoryGraphRecommendation = z.infer<typeof MemoryGraphRecommendation>;

export const MemoryGraphResult = z.object({
  query: z.string(),
  summary: MemoryGraphSummary,
  nodes: z.array(MemoryGraphNode),
  edges: z.array(MemoryGraphEdge),
  issues: z.array(MemoryGraphIssue),
  recommendations: z.array(MemoryGraphRecommendation),
  hits: z.array(RecallHit),
});
export type MemoryGraphResult = z.infer<typeof MemoryGraphResult>;

/** Input for the `doc_history` MCP tool / `gps doc-history` command. */
export const DocHistoryToolInput = z.object({
  pr: z.number().int().positive().optional().describe("PR number to document (pulls comments + labels via gh)"),
  branch: z.string().optional().describe("Tip ref of the commit walk (default: HEAD)"),
  base: z.string().optional().describe("Base ref the walk starts from (default: merge-base with origin/HEAD)"),
  event: z
    .enum(["commit", "pr-regen", "pr-merge"])
    .optional()
    .describe("Tag the tip snapshot (default: commit)"),
  out: z.string().optional().describe("Output directory (default: doc out_dir)"),
  llm: z.boolean().optional().describe("Enable LLM gap-fill on the tip snapshot (default: config)"),
  full_snapshots: z.number().int().positive().optional().describe("Keep full diff bodies for only the latest K snapshots"),
  max_diff_bytes: z.number().int().positive().optional().describe("Omit per-file bodies when a snapshot diff exceeds this"),
});
export type DocHistoryToolInput = z.infer<typeof DocHistoryToolInput>;

export const DocHistoryToolResult = z.object({
  id: z.string(),
  added: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  history_dir: z.string(),
  html_path: z.string(),
});
export type DocHistoryToolResult = z.infer<typeof DocHistoryToolResult>;

export const TOOLS = {
  prepare_edit: {
    description:
      "Single decision-ready brief before editing a symbol. Returns structure, tests, invariants, and risk in one shot. Call this first when about to modify code.",
    input: PrepareEditInput,
    output: PrepareEditResult,
  },
  get_context: {
    description:
      "Multi-strand context (structure, tests, provenance, invariants) for a symbol. Call this when you need depth on a single symbol but don't yet know what you'll change — use prepare_edit instead when you have an intent in mind. Returns concrete file:line citations; prefer this over Glob/Read/Grep exploration for any indexed symbol.",
    input: GetContextInput,
    output: ContextResult,
  },
  impact_of: {
    description:
      "Blast radius of changing a symbol: callers, transitively affected symbols, files, and tests. Call before any refactor that touches a function used elsewhere — saves a manual caller hunt.",
    input: ImpactInput,
    output: ImpactResult,
  },
  resolve: {
    description:
      "FIRST STEP for any bug fix, refactor, or non-trivial edit: returns one complete blast-radius packet for a target — a symbol name, file path, commit SHA, or PR number. In a single call you get the forward+reverse dependency closure (callers AND callees), the exact tests to run, every invariant that applies (blocking ones first — these MUST be respected), prior notes and decisions on the affected code, related repo memory, and recent git/PR history. Call this BEFORE reading or editing code: it replaces a manual hunt through callers, tests, and git blame, and surfaces constraints you would otherwise violate. Pass a symbol to scope to one function, a file path for a whole file, or a commit/PR to understand a change set. Then make your edit and run `gate`/`brief` before declaring done.",
    input: ResolvePacketInput,
    output: ResolvePacketResult,
  },
  tests_for: {
    description:
      "Tests that protect a symbol. Call after an edit to know exactly what to run; framework (vitest/jest/pytest/mocha) is detected automatically.",
    input: TestsForInput,
    output: TestsForResult,
  },
  invariants_for: {
    description:
      "Asserted invariants that apply to a symbol. Call before editing — invariants with severity=block must be respected. Authored by the team in .gps/invariants.yml.",
    input: InvariantsForInput,
    output: InvariantsForResult,
  },
  find_reusable: {
    description:
      "Search the symbol graph for existing helpers before writing new code. Call this whenever you're about to add a utility function — there's usually one already.",
    input: FindReusableInput,
    output: FindReusableResult,
  },
  recall_memory: {
    description:
      "Search ALL repo memory by topic — notes, decisions, invariants, preferences, and global lessons ranked against a free-text query. Use this to answer \"what do we already know about X?\" (e.g. refunds, auth, rate limiting) when you don't have a specific symbol in mind; set related=true to attach nearby symbol-graph context (anchors, callers, callees). For depth on one known symbol, use prepare_edit/get_context instead.",
    input: RecallMemoryInput,
    output: RecallMemoryResult,
  },
  memory_graph: {
    description:
      "Build a small knowledge graph around a topic: recalled memory artifacts, anchored symbols, top matching code symbols, and one-hop caller/callee edges when the symbol index is available. Use this when planning broad work and you need to see how repo knowledge connects, including memory gaps to fill.",
    input: MemoryGraphInput,
    output: MemoryGraphResult,
  },
  memory_health: {
    description:
      "Repo-wide memory health score and maintenance actions. Combines active memory counts, review queue debt, validation drift, prunable stale memories, and changed-symbol memory suggestions into one agent-readable dashboard.",
    input: MemoryHealthInput,
    output: MemoryHealthResult,
  },
  memory_suggestions: {
    description:
      "Closeout memory queue for the current diff. Lists changed symbols that need durable memory, unresolved questions, unverified assumptions, or open TODOs before an agent declares work done.",
    input: MemorySuggestionsInput,
    output: MemorySuggestionsResult,
  },
  change_summary: {
    description:
      "Summarize the current change set as changed files, touched indexed symbols, commits, and PR references. Use for PR/change understanding without generating a full doc.",
    input: ChangeSummaryInput,
    output: ChangeSummary,
  },
  record_learning: {
    description:
      "Persist a lesson learned about a symbol. Call after a non-trivial edit to make future agents and humans inherit what you discovered. Lessons are short, actionable, and tied to one symbol.",
    input: RecordLearningInput,
    output: RecordLearningResult,
  },
  notes_for: {
    description:
      "Lessons (notes) attached to a symbol. Returns un-promoted notes by default; set include_promoted to also see ones that have been lifted to invariants.",
    input: NotesForInput,
    output: NotesForResult,
  },
  record_decision: {
    description:
      "Persist a decision made about a symbol — a choice with the rejected alternative and rationale. Use when an explicit design choice was made that future agents and humans should not re-litigate.",
    input: RecordDecisionInput,
    output: RecordDecisionResult,
  },
  decisions_for: {
    description:
      "Choices previously recorded for a symbol — including the rejected alternative and rationale. Call before re-litigating a design choice; if a decision exists, follow it or explicitly supersede it.",
    input: DecisionsForInput,
    output: DecisionsForResult,
  },
  suggest: {
    description:
      "Authoring queue: symbols agents have queried frequently that have no covering invariant. Use to find what's worth documenting next.",
    input: SuggestInput,
    output: SuggestResult,
  },
  record_lesson: {
    description:
      "Persist a lesson and let gps classify its scope (symbol|file|feature|global). Repo-wide lessons go to the CLAUDE.md managed block (always loaded); scoped lessons go to .gps/notes/* (pulled on-demand). Pass hint_scope/hint_target to bias the classifier, or force_scope to skip it. Use this in preference to record_learning when the lesson may not belong to a single symbol.",
    input: RecordLessonInput,
    output: RecordLessonResult,
  },
  lessons_list: {
    description:
      "List recorded lessons across scopes (global, file, feature, symbol). Filter by scope or target. Use when you want to audit what gps knows about a topic before adding more.",
    input: LessonsListInput,
    output: LessonsListResult,
  },
  reclassify_lesson: {
    description:
      "Move a lesson between scopes (e.g. promote a scoped note to CLAUDE.md or demote a global lesson to a symbol/file).",
    input: ReclassifyLessonInput,
    output: ReclassifyLessonResult,
  },
  record_directive: {
    description:
      "Call this when the user gives a location-scoped instruction during a task — e.g. \"don't do X here\", \"always Y in this folder\", \"in the home page, avoid Z\". gps resolves \"here\"/\"this\" to the active area (a directory) and persists the directive as an area-scoped note, so future edits anywhere in that directory inherit it. Pass `area` or `alias` to target a specific location; otherwise the active area is used. Use this in preference to record_lesson when the instruction is about a place rather than a symbol.",
    input: RecordDirectiveInput,
    output: RecordDirectiveResult,
  },
  list_todos: {
    description:
      "List TODOs GPS has captured for a file or symbol. Surfaces unfinished work (failed tests, captured notes) without editing source files.",
    input: z.object({
      file: z.string().optional(),
      symbol: z.string().optional(),
      include_resolved: z.boolean().optional(),
    }),
    output: z.object({ todos: z.array(TodoItem) }),
  },
  resolve_todo: {
    description: "Mark a GPS-tracked TODO as resolved by id.",
    input: z.object({ id: z.string() }),
    output: z.object({ resolved: z.boolean() }),
  },
  gate_check: {
    description:
      "Check whether the current diff (or a specified file set) touches any blocking invariants. Returns all hits with waiver status; `blocking` is the subset that should fail CI. Call this before committing changes that may touch governed code paths.",
    input: GateCheckInput,
    output: GateCheckResult,
  },
  audit_session: {
    description:
      "Run self-audit checks for the active session: did the agent call prepare_edit before editing, were required tests recorded, etc. Use to verify the agent followed the brief before declaring a task done.",
    input: AuditSessionInput,
    output: AuditSessionResult,
  },
  feature_health: {
    description:
      "Knowledge-layer health score for one feature (when `feature` is set) or all features. Aggregates invariants, notes, decisions, open questions, unverified assumptions, and conflicts into a 0..1 score. Use to find the weakest feature in the repo.",
    input: FeatureHealthInput,
    output: FeatureHealthResult,
  },
  find_conflicts: {
    description:
      "Detect contradictions between invariants, decisions, and notes for a symbol — e.g. a decision says $1000 cap but a note says $500. Call before recording a new decision so you don't re-introduce a known conflict.",
    input: FindConflictsInput,
    output: FindConflictsResult,
  },
  find_stale: {
    description:
      "Notes, decisions, and open questions older than `days` whose underlying file has since been touched — i.e. the code moved but the knowledge didn't. The maintenance queue.",
    input: FindStaleInput,
    output: FindStaleResult,
  },
  record_question: {
    description:
      "Persist an open question against a symbol. Use when the agent encounters ambiguity it cannot resolve from context alone — the question goes to a human review queue (see questions_for).",
    input: RecordQuestionInput,
    output: RecordQuestionResult,
  },
  questions_for: {
    description:
      "List recorded open questions, optionally filtered by symbol and/or status. Call before asking a human — if the same question is already open, link to it rather than duplicate.",
    input: QuestionsForInput,
    output: QuestionsForResult,
  },
  resolve_question: {
    description:
      "Resolve (or mark wontfix) a previously recorded question by id. Pass a resolution string to record the answer for future agents.",
    input: ResolveQuestionInput,
    output: ResolveQuestionResult,
  },
  record_assumption: {
    description:
      "Persist an assumption made about a symbol (e.g. 'inputs are pre-validated'). Future edits get a chance to verify or invalidate it. Use when behavior depends on unstated contracts.",
    input: RecordAssumptionInput,
    output: RecordAssumptionResult,
  },
  assumptions_for: {
    description:
      "List assumptions recorded for a symbol with their verification status. Call before relying on implicit behavior — unverified assumptions are common bug sources.",
    input: AssumptionsForInput,
    output: AssumptionsForResult,
  },
  contributors_for: {
    description:
      "Rank contributors by accumulated context for a symbol (commit share + recorded decisions). Use to find a human reviewer for a non-trivial change.",
    input: ContributorsForInput,
    output: ContributorsForResult,
  },
  record_preference: {
    description:
      "Persist a coding preference (e.g. 'prefer named imports', 'no console.log in committed code'). Preferences surface in prepare_edit briefs and influence agent suggestions.",
    input: RecordPreferenceInput,
    output: RecordPreferenceResult,
  },
  preferences_list: {
    description:
      "List recorded preferences across scopes (repo, user, global).",
    input: PreferencesListInput,
    output: PreferencesListResult,
  },
  build_contract: {
    description:
      "Build a strict edit contract for a symbol: which files/symbols may be touched, which tests must run, which invariants block, which callers are risky. Persisted by default so verify_contract can check the working diff against it.",
    input: BuildContractInput,
    output: BuildContractResult,
  },
  verify_contract: {
    description:
      "Check the working git diff (vs `base`) against the last saved edit contract. Returns violations (out-of-scope files/symbols, untouched blockers). Call before declaring an edit task complete.",
    input: VerifyContractInput,
    output: VerifyContractResult,
  },
  check_proposal: {
    description:
      "Search prior decisions for rejected_alternatives that overlap with a proposed approach — surfaces 'we already decided against this' before the agent re-proposes a known bad path.",
    input: CheckProposalInput,
    output: CheckProposalResult,
  },
  promotion_candidates: {
    description:
      "Rule-based clustering of un-promoted notes on a symbol; clusters with ≥ min_occurrences and overlap ≥ threshold are candidates for promotion to invariants. Use as the authoring queue for the team's rules layer.",
    input: PromotionCandidatesInput,
    output: PromotionCandidatesResult,
  },
  verify_index: {
    description:
      "Score GPS's symbol graph against TypeScript's type checker. Returns precision (GPS edges ts confirms), recall (ts edges GPS found), coverage (% of edges with exact|typed status), and a list of worst-offending callsites. Use this to prove GPS's affected-symbols claims are trustworthy on a given repo, or to find graph-quality regressions after a parser change.",
    input: VerifyIndexInput,
    output: VerifyIndexResult,
  },
  gate_stream: {
    description:
      "Tail the live gate stream — invariant violations detected while files were being edited (via `gps gate --watch` or a PostToolUse hook). Use between tool calls to catch a violation you just introduced. Preferred cursor: `since_seq` (monotonic counter from the last entry you saw; returns entries with seq > since_seq). `since` (ISO timestamp) is accepted for backwards compatibility and ignored when `since_seq` is supplied. Use `limit` to cap the last N.",
    input: GateStreamInput,
    output: GateStreamResult,
  },
  review_diff: {
    description:
      "Final-call invariant check against the current dirty diff. Maps changed hunks to changed symbols and runs the gate. Call before declaring an edit done.",
    input: ReviewDiffInput,
    output: ReviewDiffResult,
  },
  review_memory: {
    description:
      "Maintainer queue for GPS memory. Returns promotion candidates, stale entries, open questions, and a prioritized action list with MCP-invokable follow-up actions. Use periodically to keep the repo knowledge graph healthy.",
    input: ReviewMemoryInput,
    output: ReviewMemoryResult,
  },
  seed_propose: {
    description:
      "Mine repo history (TODOs, commits, PRs) for candidate notes and invariants. Tiered by confidence: safe (TODOs/FIXMEs only), medium (+ recent commits/PRs), aggressive (+ blame, weaker signals). Returns proposals — does not auto-write. Pair with `gps init --seed <tier>` for the CLI flow that drops candidates into .gps/candidates/.",
    input: SeedProposeInput,
    output: SeedProposeResult,
  },
  validate_knowledge: {
    description:
      "Audit notes, decisions, and invariants for anchor drift: symbols that vanished, anchors using legacy line-based IDs, and entries past expires_at. Returns suggested re-anchors when a fuzzy match exists. Run periodically after refactors to keep memory from rotting.",
    input: ValidateKnowledgeInput,
    output: ValidateKnowledgeResult,
  },
  brief: {
    description:
      "Pre-finalize briefing for the dirty diff. Returns changed symbols, invariants that apply to them, notes attached to changed symbols/files/areas, tests likely to run, and a list of changed symbols with no test coverage. Call this as the last step before declaring an edit done — pairs with prepare_edit on the front end.",
    input: BriefInput,
    output: BriefResult,
  },
  prune: {
    description:
      "Remove stale notes that have not been surfaced to an agent for more than `days` days (default 90), are not promoted, are not high-severity, and are not from a trusted human source (human/doc/incident/pr). Also removes any note/decision past its expires_at. Pass dry_run=true to see what would be removed without writing. Run periodically to prevent memory bloat.",
    input: PruneInput,
    output: PruneResult,
  },
  resume: {
    description:
      "\"Where was I?\" — surface the TODO(symbol): notes, open questions, and recent decisions tied to the files in the current git diff. Returns a markdown brief plus structured data. Call at the start of a session to orient quickly without re-reading all source files.",
    input: ResumeInput,
    output: ResumeResult,
  },
  doc_history: {
    description:
      "Capture or refresh a time-scrubbable history doc for a PR or branch: snapshots the code + annotations + PR comments/labels at each commit (and optionally a pr-regen/pr-merge event), writing a single self-contained HTML scrubber plus per-snapshot JSON under .gps/docs/history. Read-only on git — never touches the working tree. Use to review how a change and its rationale evolved over time, or to keep a living history doc for a PR.",
    input: DocHistoryToolInput,
    output: DocHistoryToolResult,
  },
} as const;

export type ToolName = keyof typeof TOOLS;

/* ---------- Doc store (v1.0) ----------
 *
 * Shareable, human-facing documentation generated from a repo or a PR diff.
 * `gps doc` (and the optional attach auto-hook) assembles a `DocModel` and
 * renders it to a self-contained HTML file + a markdown sibling under
 * `.gps/docs/`. Annotations ("lines 14-30 do X") come from existing gps
 * notes/decisions, with `gps-llm` filling in changed hunks that have no note.
 */

/** Feature config persisted under the `doc:` key of `.gps/config.yml`. */
export const DocConfig = z.object({
  /** Master switch. When false the attach hook never auto-generates docs. */
  enabled: z.boolean().default(false),
  /** Regenerate inside the attach/PR Stop hook (only honored when enabled). */
  auto: z.boolean().default(false),
  /** Where generated docs land, relative to repo root. */
  out_dir: z.string().default(".gps/docs"),
  /** Syntax-highlight code in the HTML output. */
  highlight: z.boolean().default(true),
  /** Allow the LLM to annotate changed hunks that have no captured note. */
  llm_fill: z.boolean().default(true),
  /** Diff layout in the HTML code view. */
  diff_view: z.enum(["unified", "split"]).default("unified"),
  /** Skip per-file bodies once the raw diff exceeds this many bytes. */
  max_diff_bytes: z.number().int().positive().default(1_500_000),
});
export type DocConfig = z.infer<typeof DocConfig>;

export const DocLanguage = z.enum(["typescript", "javascript", "python", "other"]);
export type DocLanguage = z.infer<typeof DocLanguage>;

/** A line range on the new side of a changed file (1-indexed, inclusive). */
export const HunkRangeSchema = z.object({
  file: z.string(),
  start_line: z.number().int().nonnegative(),
  end_line: z.number().int().nonnegative(),
});
export type HunkRangeSchema = z.infer<typeof HunkRangeSchema>;

export const DocAnnotationKind = z.enum(["note", "decision", "lesson", "llm", "question"]);
export type DocAnnotationKind = z.infer<typeof DocAnnotationKind>;

/** One "lines X-Y do Z" callout, anchored to a file + line range. */
export const DocAnnotation = z.object({
  file: z.string(),
  start_line: z.number().int().nonnegative(),
  end_line: z.number().int().nonnegative(),
  /** Plain-english explanation / lesson text. */
  text: z.string(),
  kind: DocAnnotationKind,
  severity: NoteSeverity.optional(),
  /** Origin label: note.source, "decision", "llm", … */
  source: z.string(),
  symbol: z.string().optional(),
  evidence_link: z.string().optional(),
});
export type DocAnnotation = z.infer<typeof DocAnnotation>;

export const DocFileStatus = z.enum(["added", "modified", "deleted", "renamed"]);
export type DocFileStatus = z.infer<typeof DocFileStatus>;

/** A single changed file in a doc, with its diff body and overlaid annotations. */
export const DocFileEntry = z.object({
  path: z.string(),
  language: DocLanguage,
  status: DocFileStatus,
  /** Per-file unified-diff segment (the raw `diff --git …` block). */
  diff: z.string().optional(),
  /** Full new-side source, when rendering a non-diff (repo) file view. */
  after: z.string().optional(),
  hunks: z.array(HunkRangeSchema).default([]),
  annotations: z.array(DocAnnotation).default([]),
  binary: z.boolean().default(false),
  truncated: z.boolean().default(false),
});
export type DocFileEntry = z.infer<typeof DocFileEntry>;

export const DocStats = z.object({
  files_changed: z.number().int().nonnegative().default(0),
  added_lines: z.number().int().nonnegative().default(0),
  deleted_lines: z.number().int().nonnegative().default(0),
  annotations: z.number().int().nonnegative().default(0),
  high_severity_annotations: z.number().int().nonnegative().default(0),
  unannotated_hunks: z.number().int().nonnegative().default(0),
  binary_files: z.number().int().nonnegative().default(0),
  truncated_files: z.number().int().nonnegative().default(0),
  by_status: z.record(z.number().int().nonnegative()).default({}),
});
export type DocStats = z.infer<typeof DocStats>;

/** A prose/feature block in the human-readable view. */
export const DocSection = z.object({
  id: z.string(),
  title: z.string(),
  markdown: z.string(),
  kind: z.enum(["narrative", "mermaid", "image", "html"]).default("narrative"),
});
export type DocSection = z.infer<typeof DocSection>;

/**
 * The intermediate structure both renderers (`renderDocMarkdown`,
 * `renderDocHtml`) consume. The builder is the only place doing I/O; renderers
 * are pure `DocModel -> string`.
 */
export const DocModel = z.object({
  schema_version: z.literal(1).default(1),
  kind: z.enum(["pr", "repo"]),
  title: z.string(),
  subtitle: z.string().optional(),
  generated_at: z.string(),
  base: z.string().optional(),
  pr: z
    .object({ number: z.number(), title: z.string(), body: z.string() })
    .optional(),
  /** Machine-readable summary used by renderers and PR comments. */
  stats: DocStats.optional(),
  files: z.array(DocFileEntry).default([]),
  sections: z.array(DocSection).default([]),
  /** Notes whose line range could not be resolved onto a changed file. */
  annotations_unanchored: z.array(DocAnnotation).default([]),
});
export type DocModel = z.infer<typeof DocModel>;

/** Index of generated docs, persisted at `<out_dir>/manifest.json`. */
export const DocManifest = z.object({
  version: z.literal(1).default(1),
  docs: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(["pr", "repo"]),
        title: z.string(),
        html_path: z.string(),
        md_path: z.string(),
        generated_at: z.string(),
        pr_number: z.number().optional(),
      }),
    )
    .default([]),
});
export type DocManifest = z.infer<typeof DocManifest>;

/** What caused a snapshot to be captured in a doc's history. */
export const DocSnapshotEvent = z.enum(["commit", "pr-regen", "pr-merge"]);
export type DocSnapshotEvent = z.infer<typeof DocSnapshotEvent>;

/** One PR review or thread comment, captured alongside a snapshot. */
export const DocPrComment = z.object({
  author: z.string(),
  body: z.string(),
  /** "review" carries a state (APPROVED/…); "comment" is a plain thread comment. */
  kind: z.enum(["review", "comment"]),
  state: z.string().optional(),
});
export type DocPrComment = z.infer<typeof DocPrComment>;

/**
 * A single point in a doc's life: the full DocModel state at a commit/event,
 * plus the PR-side context (comments, labels) as of that moment.
 */
export const DocSnapshot = z.object({
  schema_version: z.literal(1).default(1),
  /** Commit SHA for "commit" events; the tip SHA for regen/merge (best-effort). */
  sha: z.string().optional(),
  /** Short SHA / human label shown on the scrubber tick. */
  ref: z.string().optional(),
  event: DocSnapshotEvent,
  captured_at: z.string(),
  /** Commit metadata, present for "commit" events. */
  commit: z
    .object({ author: z.string(), date: z.string(), message: z.string() })
    .optional(),
  /** The full doc state at this point in time. */
  model: DocModel,
  /** PR comments/reviews as of this snapshot (empty for pure local commits). */
  pr_comments: z.array(DocPrComment).default([]),
  /** PR labels as of this snapshot. */
  labels: z.array(z.string()).default([]),
});
export type DocSnapshot = z.infer<typeof DocSnapshot>;

/** Ordered (oldest → newest) series of snapshots for one doc id. */
export const DocHistory = z.object({
  schema_version: z.literal(1).default(1),
  id: z.string(),
  kind: z.enum(["pr", "repo"]),
  title: z.string(),
  pr_number: z.number().optional(),
  snapshots: z.array(DocSnapshot).default([]),
});
export type DocHistory = z.infer<typeof DocHistory>;

/** Index of generated doc histories, at `<out_dir>/history/manifest.json`. */
export const DocHistoryManifest = z.object({
  version: z.literal(1).default(1),
  histories: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(["pr", "repo"]),
        title: z.string(),
        html_path: z.string(),
        snapshot_count: z.number().int().nonnegative(),
        updated_at: z.string(),
        pr_number: z.number().optional(),
      }),
    )
    .default([]),
});
export type DocHistoryManifest = z.infer<typeof DocHistoryManifest>;

/** One un-annotated changed hunk handed to the LLM for a plain-english gloss. */
export const DocAnnotateRequest = z.object({
  file: z.string(),
  symbol: z.string().optional(),
  start_line: z.number().int().nonnegative(),
  end_line: z.number().int().nonnegative(),
  language: z.string(),
  /** The changed code (new side) the LLM should explain. */
  code: z.string(),
});
export type DocAnnotateRequest = z.infer<typeof DocAnnotateRequest>;

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convertJsonSchema(schema);
}

function convertJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  if (schema instanceof z.ZodDefault || schema instanceof z.ZodOptional) {
    return convertJsonSchema(schema._def.innerType);
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
  if (schema instanceof z.ZodArray) {
    return { type: "array", items: convertJsonSchema(schema.element) };
  }
  if (schema instanceof z.ZodRecord) return { type: "object", additionalProperties: true };
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      const child = value as z.ZodTypeAny;
      properties[key] = convertJsonSchema(child);
      if (!(child instanceof z.ZodDefault) && !(child instanceof z.ZodOptional)) required.push(key);
    }
    return {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    };
  }
  return {};
}
