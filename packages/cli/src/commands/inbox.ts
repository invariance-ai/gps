import type { Command } from "commander";
import kleur from "kleur";
import {
  loadInbox,
  approveInboxItem,
  rejectInboxItem,
  editInboxItem,
} from "@invariance/gps-core";
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
    let items = await loadInbox(root);
    if (!opts.all) items = items.filter((i) => i.status === "pending");
    if (opts.risk) items = items.filter((i) => i.risk_topics.includes(opts.risk!));

    if (opts.json) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }
    if (items.length === 0) {
      console.log(kleur.dim("inbox empty — nothing waiting for review"));
      return;
    }
    console.log(kleur.bold(`${items.length} item${items.length === 1 ? "" : "s"} in inbox:`));
    console.log("");
    for (const i of items) {
      const risk = i.risk_topics.length
        ? " " + kleur.red(`⚠ ${i.risk_topics.join(", ")}`)
        : "";
      const status = i.status === "pending" ? "" : " " + kleur.dim(`[${i.status}]`);
      console.log(`${kleur.cyan(i.id)} ${kleur.dim(`(${i.kind})`)} ${i.text}${risk}${status}`);
    }
    console.log("");
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
