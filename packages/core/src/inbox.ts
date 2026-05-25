import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  InboxItem,
  type InboxItem as InboxItemT,
  type InboxItemKind,
} from "@invariance/gps-schemas";
import { matchedRiskTopics } from "./risk_topics.js";
import {
  addPreference,
  loadPreferences,
  type AddPreferenceOpts,
  type AddPreferenceResult,
} from "./preferences.js";
import { recordDirective } from "./lessons.js";
import { loadPolicy } from "./scan.js";
import { loadAreaNotes } from "./notes.js";
import { tokenize, jaccard } from "./text_similarity.js";

/**
 * The inbox is a single flat YAML array (`.gps/inbox.yml`) — a chronological
 * review queue with no natural lookup key, mirroring `preferences.yml`. Items
 * keep their status (pending/approved/rejected) for an audit trail.
 */
const REL = ".gps/inbox.yml";

export function inboxPath(root: string): string {
  return path.join(root, REL);
}

function idFor(kind: string, text: string): string {
  return createHash("sha1")
    .update(`${kind}\0${text.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 12);
}

/**
 * sha1 of the normalized text alone — the SAME formula `preferences.ts` uses
 * for its ids. So `preferenceIdFor(item.text) === pref.id` is an exact-content
 * duplicate, independent of the kind-prefixed inbox id above.
 */
function preferenceIdFor(text: string): string {
  return createHash("sha1").update(text.trim().toLowerCase()).digest("hex").slice(0, 12);
}

export async function loadInbox(root: string): Promise<InboxItemT[]> {
  try {
    const raw = await readFile(inboxPath(root), "utf8");
    const data = parseYaml(raw);
    if (!Array.isArray(data)) return [];
    return data.map((d: unknown) => InboxItem.parse(d));
  } catch {
    return [];
  }
}

async function persist(root: string, items: InboxItemT[]): Promise<void> {
  const file = inboxPath(root);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stringifyYaml(items));
}

/** Resolve an item by exact id or unambiguous prefix; null if none/ambiguous. */
export function findByIdOrPrefix(items: InboxItemT[], idOrPrefix: string): InboxItemT | null {
  const exact = items.find((i) => i.id === idOrPrefix);
  if (exact) return exact;
  const matches = items.filter((i) => i.id.startsWith(idOrPrefix));
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * A pending inbox item paired with an optional duplicate marker. When set,
 * `duplicate_of` carries a short description of the ALREADY-ACTIVE memory entry
 * (an approved preference or an area note) that the item reproduces, so the CLI
 * can tag it `[duplicate]` instead of re-surfacing it as a fresh, actionable
 * lesson. `match` distinguishes an exact id collision from a near-equal rewrite.
 */
export interface AnnotatedInboxItem {
  item: InboxItemT;
  /** Set iff the item duplicates active memory; a human-readable handle. */
  duplicate_of?: string;
  match?: "exact" | "near";
}

/**
 * Lexical-overlap gate for flagging a pending item as a near-duplicate of an
 * already-active entry. Deliberately conservative: reworded copies of the same
 * rule clear it, but genuinely different rules (even on the same topic) must
 * stay separate, so a borderline pair is left UNtagged rather than merged.
 */
export const INBOX_DUPLICATE_GATE = 0.7;

/**
 * Compare each pending item against ACTIVE memory and mark the ones that
 * reproduce something already approved. Preferences are matched against
 * `preferences.yml`; directives against the area notes of their resolved area.
 * Exact matches use the shared sha1 id; near matches use a conservative jaccard
 * gate. Non-pending items and items with no active counterpart pass through
 * unmarked. Pure read — never mutates the inbox.
 */
export async function annotateInboxDuplicates(
  root: string,
  items: InboxItemT[],
): Promise<AnnotatedInboxItem[]> {
  // Active preferences keyed by their sha1 id (== idFor("preference", text)).
  const prefs = await loadPreferences(root);
  const prefById = new Map(prefs.map((p) => [p.id, p] as const));
  const prefTokens = prefs.map((p) => ({ p, tokens: tokenize(p.text) }));

  // Area notes are loaded lazily per resolved area (directives only).
  const notesByArea = new Map<string, { lesson: string; tokens: Set<string> }[]>();
  async function notesFor(area: string) {
    let cached = notesByArea.get(area);
    if (!cached) {
      const notes = await loadAreaNotes(root, area);
      cached = notes.map((n) => ({ lesson: n.lesson, tokens: tokenize(n.lesson) }));
      notesByArea.set(area, cached);
    }
    return cached;
  }

  const out: AnnotatedInboxItem[] = [];
  for (const item of items) {
    if (item.status !== "pending") {
      out.push({ item });
      continue;
    }

    if (item.kind === "preference") {
      // Exact: same normalized text → same sha1 as the stored preference.
      const exact = prefById.get(preferenceIdFor(item.text));
      if (exact) {
        out.push({ item, duplicate_of: `preference "${exact.text}"`, match: "exact" });
        continue;
      }
      const tokens = tokenize(item.text);
      let best: { text: string; score: number } | null = null;
      for (const { p, tokens: pt } of prefTokens) {
        const score = jaccard(tokens, pt);
        if (score >= INBOX_DUPLICATE_GATE && (!best || score > best.score)) {
          best = { text: p.text, score };
        }
      }
      out.push(
        best ? { item, duplicate_of: `preference "${best.text}"`, match: "near" } : { item },
      );
      continue;
    }

    // directive → compare against the area notes of its resolved area.
    if (!item.area) {
      out.push({ item });
      continue;
    }
    const notes = await notesFor(item.area);
    const norm = item.text.trim().toLowerCase();
    const exactNote = notes.find((n) => n.lesson.trim().toLowerCase() === norm);
    if (exactNote) {
      out.push({ item, duplicate_of: `area note "${exactNote.lesson}"`, match: "exact" });
      continue;
    }
    const tokens = tokenize(item.text);
    let best: { lesson: string; score: number } | null = null;
    for (const n of notes) {
      const score = jaccard(tokens, n.tokens);
      if (score >= INBOX_DUPLICATE_GATE && (!best || score > best.score)) {
        best = { lesson: n.lesson, score };
      }
    }
    out.push(
      best ? { item, duplicate_of: `area note "${best.lesson}"`, match: "near" } : { item },
    );
  }
  return out;
}

export interface AddToInboxOpts {
  kind: InboxItemKind;
  text: string;
  source?: string;
  polarity?: "do" | "dont";
  area?: string;
  evidence?: string;
}

export interface AddToInboxResult {
  item: InboxItemT;
  deduped: boolean;
}

/**
 * Queue a captured item for review. Dedupes on id (kind + normalized text):
 * a repeat capture is a no-op so the queue doesn't fill with the same lesson.
 */
export async function addToInbox(root: string, opts: AddToInboxOpts): Promise<AddToInboxResult> {
  const id = idFor(opts.kind, opts.text);
  const existing = await loadInbox(root);
  const dupe = existing.find((i) => i.id === id);
  if (dupe) return { item: dupe, deduped: true };
  const item = InboxItem.parse({
    id,
    kind: opts.kind,
    text: opts.text.trim(),
    status: "pending",
    captured_at: new Date().toISOString(),
    source: opts.source ?? "auto",
    risk_topics: matchedRiskTopics(opts.text),
    polarity: opts.polarity,
    area: opts.area,
    evidence: opts.evidence,
  });
  await persist(root, [...existing, item]);
  return { item, deduped: false };
}

/** Mark an item rejected (kept for the audit trail). Returns null if not found. */
export async function rejectInboxItem(root: string, idOrPrefix: string): Promise<InboxItemT | null> {
  const items = await loadInbox(root);
  const item = findByIdOrPrefix(items, idOrPrefix);
  if (!item) return null;
  item.status = "rejected";
  await persist(root, items);
  return item;
}

/**
 * Rewrite a pending item's text in place (id is left stable so the same handle
 * keeps working) and recompute its risk topics. Returns null if not found.
 */
export async function editInboxItem(
  root: string,
  idOrPrefix: string,
  text: string,
): Promise<InboxItemT | null> {
  const items = await loadInbox(root);
  const item = findByIdOrPrefix(items, idOrPrefix);
  if (!item) return null;
  item.text = text.trim();
  item.risk_topics = matchedRiskTopics(item.text);
  item.status = "pending";
  await persist(root, items);
  return item;
}

export interface ApproveResult {
  item: InboxItemT;
  persisted: "preference" | "area-note";
}

/**
 * Approve a pending item: run the real persist (the single inbox→live-store
 * crossover) and flip status to approved. Throws if a directive can't resolve
 * its area; returns null if the item isn't a pending match.
 */
export async function approveInboxItem(
  root: string,
  idOrPrefix: string,
): Promise<ApproveResult | null> {
  const items = await loadInbox(root);
  const item = findByIdOrPrefix(items, idOrPrefix);
  if (!item || item.status !== "pending") return null;

  let persisted: ApproveResult["persisted"];
  if (item.kind === "preference") {
    await addPreference(root, { text: item.text, source: "wizard", evidence: item.evidence });
    persisted = "preference";
  } else {
    await recordDirective(root, {
      directive: item.text,
      polarity: item.polarity,
      area: item.area,
    });
    persisted = "area-note";
  }
  item.status = "approved";
  await persist(root, items);
  return { item, persisted };
}

/** Where an explicit preference write landed, and why. */
export interface RecordPreferenceResult {
  /** "active" → written to live memory; "inbox" → queued pending review. */
  placement: "active" | "inbox";
  /** Active-store result (present iff placement === "active"). */
  preference?: AddPreferenceResult;
  /** Inbox result (present iff placement === "inbox"). */
  inbox?: AddToInboxResult;
  deduped: boolean;
  /** Human-readable explanation of the routing decision. */
  message: string;
}

/**
 * Single routing decision for an EXPLICIT preference write (`gps prefer`,
 * `mcp__gps__record_preference`). Honors the capture gate (Fix 4, option A):
 * under `capture=inbox` the preference is queued for review instead of being
 * written straight to active memory; under `capture=auto` it writes active.
 * The hook-driven passive capture commands and this shared helper therefore
 * route identically, so explicit and passive captures obey the same policy.
 */
export async function recordPreference(
  root: string,
  opts: AddPreferenceOpts,
): Promise<RecordPreferenceResult> {
  const { capture } = await loadPolicy(root);
  if (capture === "inbox") {
    const inbox = await addToInbox(root, {
      kind: "preference",
      text: opts.text,
      source: opts.source ?? "manual",
      evidence: opts.evidence,
    });
    return {
      placement: "inbox",
      inbox,
      deduped: inbox.deduped,
      message: inbox.deduped
        ? "already queued for review (capture=inbox)"
        : "queued for review (capture=inbox)",
    };
  }
  const preference = await addPreference(root, opts);
  return {
    placement: "active",
    preference,
    deduped: preference.deduped,
    message: preference.deduped
      ? "already in active memory"
      : "recorded to active memory",
  };
}
