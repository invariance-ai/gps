import type { Command } from "commander";
import kleur from "kleur";
import {
  loadInbox,
  annotateInboxDuplicates,
  approveInboxItem,
  rejectInboxItem,
  editInboxItem,
} from "@invariance/gps-core";
import type { InboxItem } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface ListOpts extends RootOption {
  all?: boolean;
  risk?: string;
  json?: boolean;
}
interface IdOpts extends RootOption {}
interface EditOpts extends RootOption {
  text?: string;
}
interface ReviewOpts extends RootOption {
  json?: boolean;
}

type Annotated = Awaited<ReturnType<typeof annotateInboxDuplicates>>[number];

interface CliMergeSuggestion {
  canonical: InboxItem;
  duplicates: InboxItem[];
  reason: string;
  command: string;
}

interface CliInboxReview {
  pending: Annotated[];
  active_duplicates: Annotated[];
  merge_suggestions: CliMergeSuggestion[];
  risky: InboxItem[];
  scope_suggestions: Array<{ item: InboxItem; issue: string; suggestion: string }>;
  total: number;
}

function scopeSuggestions(items: InboxItem[]): CliInboxReview["scope_suggestions"] {
  const out: CliInboxReview["scope_suggestions"] = [];
  const locationCue = /\b(this folder|this directory|here|in (?:src|apps|packages|docs|lib|server|client|api|ui|web|tests?)(?:\/|\b)|under (?:src|apps|packages|docs|lib|server|client|api|ui|web|tests?)(?:\/|\b))/i;
  const durableCue = /\b(always|never|prefer|from now on|default to|use .* instead of)\b/i;
  for (const item of items) {
    if (item.status !== "pending") continue;
    if (item.kind === "preference" && locationCue.test(item.text)) {
      out.push({ item, issue: "preference looks location-scoped", suggestion: "consider rejecting it and recording a directive with an explicit area" });
    } else if (item.kind === "directive" && !item.area) {
      out.push({ item, issue: "directive has no resolved area", suggestion: "edit/record it with an area before approving" });
    } else if (item.kind === "directive" && durableCue.test(item.text) && !locationCue.test(item.text)) {
      out.push({ item, issue: "directive may be repo-wide", suggestion: "consider recording this as a preference instead of an area directive" });
    }
  }
  return out;
}

async function buildCliInboxReview(root: string): Promise<CliInboxReview> {
  const items = await loadInbox(root);
  const annotated = await annotateInboxDuplicates(root, items);
  const byPendingText = new Map<string, InboxItem>();
  for (const a of annotated) {
    if (a.item.status === "pending" && !byPendingText.has(a.item.text)) byPendingText.set(a.item.text, a.item);
  }
  const mergeByCanonical = new Map<string, CliMergeSuggestion>();
  for (const a of annotated) {
    if (a.item.status !== "pending" || !a.duplicate_of?.startsWith("pending \"")) continue;
    const text = a.duplicate_of.slice("pending \"".length, -1);
    const canonical = byPendingText.get(text);
    if (!canonical) continue;
    const existing = mergeByCanonical.get(canonical.id) ?? {
      canonical,
      duplicates: [],
      reason: `near-duplicate ${canonical.kind} captures`,
      command: `gps inbox merge ${canonical.id}`,
    };
    existing.duplicates.push(a.item);
    mergeByCanonical.set(canonical.id, existing);
  }
  const mergeSuggestions = [...mergeByCanonical.values()];
  const duplicateIds = new Set(mergeSuggestions.flatMap((m) => m.duplicates.map((d) => d.id)));
  const pending = annotated.filter((a) => a.item.status === "pending" && !a.duplicate_of && !duplicateIds.has(a.item.id));
  const activeDuplicates = annotated.filter(
    (a) => a.item.status === "pending" && !!a.duplicate_of && !a.duplicate_of.startsWith("pending "),
  );
  const risky = pending.map((a) => a.item).filter((i) => i.risk_topics.length > 0);
  const scope = scopeSuggestions(items);
  return {
    pending,
    active_duplicates: activeDuplicates,
    merge_suggestions: mergeSuggestions,
    risky,
    scope_suggestions: scope,
    total: pending.length + activeDuplicates.length + mergeSuggestions.length + risky.length + scope.length,
  };
}

async function mergeCliInboxDuplicates(root: string, id: string) {
  const review = await buildCliInboxReview(root);
  const suggestions = review.merge_suggestions.filter((s) => s.canonical.id === id || s.canonical.id.startsWith(id));
  if (suggestions.length !== 1) return null;
  const suggestion = suggestions[0]!;
  const approved = await approveInboxItem(root, suggestion.canonical.id);
  if (!approved) return null;
  const rejected: InboxItem[] = [];
  for (const duplicate of suggestion.duplicates) {
    const item = await rejectInboxItem(root, duplicate.id);
    if (item) rejected.push(item);
  }
  return { approved, rejected };
}

export function registerInbox(program: Command): void {
  const inbox = program
    .command("inbox")
    .description("Review memory captured under --capture=inbox before it activates");

  // `gps inbox` with no subcommand lists pending items.
  addRootOption(
    inbox
      .command("list", { isDefault: true })
      .description("List inbox items (pending by default)")
      .option("--all", "Include approved and rejected items")
      .option("--risk <topic>", "Only items touching the given risk topic")
      .option("--json", "Emit JSON"),
  ).action(async (opts: ListOpts) => {
    const root = resolveRoot(opts);
    const all = await loadInbox(root);
    // Tag pending items that already exist in active memory (approved
    // preference / area note) so we don't re-surface a resolved duplicate.
    let annotated = await annotateInboxDuplicates(root, all);
    if (!opts.all) annotated = annotated.filter((a) => a.item.status === "pending");
    if (opts.risk) annotated = annotated.filter((a) => a.item.risk_topics.includes(opts.risk!));
    // Hide duplicates from the default actionable view; --all reveals them.
    const hiddenDupes = !opts.all
      ? annotated.filter((a) => a.duplicate_of).length
      : 0;
    if (!opts.all) annotated = annotated.filter((a) => !a.duplicate_of);

    if (opts.json) {
      console.log(
        JSON.stringify(
          annotated.map((a) => ({ ...a.item, duplicate_of: a.duplicate_of, match: a.match })),
          null,
          2,
        ),
      );
      return;
    }
    if (annotated.length === 0) {
      console.log(kleur.dim("inbox empty — nothing waiting for review"));
      if (hiddenDupes > 0) {
        console.log(
          kleur.dim(
            `(${hiddenDupes} duplicate${hiddenDupes === 1 ? "" : "s"} of active memory hidden — \`gps inbox list --all\` to show)`,
          ),
        );
      }
      return;
    }
    console.log(kleur.bold(`${annotated.length} item${annotated.length === 1 ? "" : "s"} in inbox:`));
    console.log("");
    for (const a of annotated) {
      const i = a.item;
      const risk = i.risk_topics.length
        ? " " + kleur.red(`⚠ ${i.risk_topics.join(", ")}`)
        : "";
      const status = i.status === "pending" ? "" : " " + kleur.dim(`[${i.status}]`);
      const dupe = a.duplicate_of
        ? " " + kleur.yellow(`[duplicate of ${a.duplicate_of}]`)
        : "";
      console.log(`${kleur.cyan(i.id)} ${kleur.dim(`(${i.kind})`)} ${i.text}${risk}${dupe}${status}`);
    }
    console.log("");
    if (hiddenDupes > 0) {
      console.log(
        kleur.dim(
          `${hiddenDupes} duplicate${hiddenDupes === 1 ? "" : "s"} of active memory hidden — \`gps inbox list --all\` to show`,
        ),
      );
    }
    console.log(kleur.dim("Approve: `gps inbox approve <id>` · Reject: `gps inbox reject <id>` · Edit: `gps inbox edit <id> --text \"…\"`"));
  });

  addRootOption(
    inbox.command("approve <id>").description("Approve an item → persist it to live memory"),
  ).action(async (id: string, opts: IdOpts) => {
    const root = resolveRoot(opts);
    try {
      const res = await approveInboxItem(root, id);
      if (!res) {
        console.error(kleur.red(`no pending inbox item matching "${id}"`));
        process.exitCode = 1;
        return;
      }
      const where = res.persisted === "preference" ? "preferences" : `area note (${res.item.area})`;
      console.log(kleur.green(`approved`) + ` ${res.item.id} → ${where}`);
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });

  addRootOption(
    inbox
      .command("review")
      .description("Summarize pending memory, duplicates, merge suggestions, risk, and scope warnings")
      .option("--json", "Emit JSON"),
  ).action(async (opts: ReviewOpts) => {
    const root = resolveRoot(opts);
    const review = await buildCliInboxReview(root);
    if (opts.json) {
      console.log(JSON.stringify(review, null, 2));
      return;
    }
    if (review.total === 0) {
      console.log(kleur.green("✓ inbox is clean — nothing to review"));
      return;
    }

    console.log(kleur.bold(`inbox review (${review.total} signal${review.total === 1 ? "" : "s"})`));

    if (review.merge_suggestions.length > 0) {
      console.log(kleur.cyan(`\nMerge suggestions (${review.merge_suggestions.length})`));
      for (const m of review.merge_suggestions) {
        console.log(`  ${kleur.yellow(m.canonical.id)} ${kleur.dim(`(${m.canonical.kind})`)} ${m.canonical.text}`);
        for (const d of m.duplicates) {
          console.log(`    ${kleur.dim("dupe")} ${d.id} ${kleur.dim(d.text)}`);
        }
        console.log(kleur.dim(`    Apply: \`${m.command}\``));
      }
    }

    if (review.active_duplicates.length > 0) {
      console.log(kleur.cyan(`\nDuplicates of active memory (${review.active_duplicates.length})`));
      for (const a of review.active_duplicates) {
        console.log(`  ${kleur.yellow(a.item.id)} ${a.item.text}`);
        console.log(kleur.dim(`    duplicate of ${a.duplicate_of} (${a.match})`));
      }
    }

    if (review.risky.length > 0) {
      console.log(kleur.cyan(`\nRisk review (${review.risky.length})`));
      for (const i of review.risky) {
        console.log(`  ${kleur.red("⚠")} ${kleur.yellow(i.id)} ${kleur.dim(`(${i.risk_topics.join(", ")})`)} ${i.text}`);
      }
    }

    if (review.scope_suggestions.length > 0) {
      console.log(kleur.cyan(`\nScope suggestions (${review.scope_suggestions.length})`));
      for (const s of review.scope_suggestions) {
        console.log(`  ${kleur.yellow(s.item.id)} ${s.item.text}`);
        console.log(kleur.dim(`    ${s.issue}: ${s.suggestion}`));
      }
    }

    const actionable = review.pending.filter(
      (a) =>
        !review.merge_suggestions.some((m) => m.canonical.id === a.item.id) &&
        !review.risky.some((r) => r.id === a.item.id) &&
        !review.scope_suggestions.some((s) => s.item.id === a.item.id),
    );
    if (actionable.length > 0) {
      console.log(kleur.cyan(`\nReady to approve (${actionable.length})`));
      for (const a of actionable) {
        console.log(`  ${kleur.yellow(a.item.id)} ${kleur.dim(`(${a.item.kind})`)} ${a.item.text}`);
      }
    }
  });

  addRootOption(
    inbox
      .command("merge <id>")
      .description("Approve a canonical pending item and reject its near-duplicate copies"),
  ).action(async (id: string, opts: IdOpts) => {
    const root = resolveRoot(opts);
    try {
      const res = await mergeCliInboxDuplicates(root, id);
      if (!res) {
        console.error(kleur.red(`no unambiguous merge suggestion matching "${id}"`));
        process.exitCode = 1;
        return;
      }
      console.log(
        kleur.green("merged") +
          ` ${res.approved.item.id} → approved, rejected ${res.rejected.length} duplicate${res.rejected.length === 1 ? "" : "s"}`,
      );
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });

  addRootOption(
    inbox.command("reject <id>").description("Reject an item (kept for the audit trail)"),
  ).action(async (id: string, opts: IdOpts) => {
    const root = resolveRoot(opts);
    const item = await rejectInboxItem(root, id);
    if (!item) {
      console.error(kleur.red(`no inbox item matching "${id}"`));
      process.exitCode = 1;
      return;
    }
    console.log(kleur.yellow(`rejected`) + ` ${item.id}`);
  });

  addRootOption(
    inbox
      .command("edit <id>")
      .description("Rewrite a pending item's text before approving")
      .option("--text <t>", "New text for the item"),
  ).action(async (id: string, opts: EditOpts) => {
    const root = resolveRoot(opts);
    if (!opts.text) {
      console.error(kleur.red("--text is required"));
      process.exitCode = 1;
      return;
    }
    const item = await editInboxItem(root, id, opts.text);
    if (!item) {
      console.error(kleur.red(`no inbox item matching "${id}"`));
      process.exitCode = 1;
      return;
    }
    console.log(kleur.green(`edited`) + ` ${item.id}: ${item.text}`);
  });
}
