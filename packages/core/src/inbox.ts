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
import { addPreference } from "./preferences.js";
import { recordDirective } from "./lessons.js";

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
