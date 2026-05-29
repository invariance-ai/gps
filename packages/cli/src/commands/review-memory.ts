import type { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import kleur from "kleur";
import { buildReviewQueue, removeNoteById, updateNoteById, reclassifyLesson } from "@invariance/gps-core";
import type { NoteScope } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  days: number;
  limit: number;
  html?: boolean;
  out?: string;
  json?: boolean;
}

interface IdOpts extends RootOption {
  by?: string;
}

interface PromoteOpts extends RootOption {
  to: string;
  target?: string;
}

function validScope(scope: string): NoteScope | undefined {
  if (scope === "global" || scope === "symbol" || scope === "file" || scope === "feature" || scope === "area") return scope;
  return undefined;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderReviewHtml(q: Awaited<ReturnType<typeof buildReviewQueue>>): string {
  const rows = q.items.map((item) => `
      <tr>
        <td><span class="pill ${esc(item.priority)}">${esc(item.priority)}</span></td>
        <td>${esc(item.symbol)}</td>
        <td>${esc(item.kind)}</td>
        <td>${esc(item.reason)}</td>
        <td><code>${esc(item.command)}</code></td>
      </tr>`).join("");
  const promote = q.promote.map((p) => `
      <li><strong>${esc(p.symbol)}</strong> <span class="muted">${esc(p.severity_hint)}</span><br>${esc(p.representative_lesson)}</li>`).join("");
  const stale = q.stale.map((s) => `
      <li><strong>${esc(s.symbol)}</strong> <span class="muted">${s.age_days}d ${esc(s.kind)}</span><br>${esc(s.text)}</li>`).join("");
  const questions = q.open_questions.map((oq) => `
      <li><strong>${esc(oq.symbol)}</strong> <span class="muted">${oq.age_days}d</span><br>${esc(oq.question)}</li>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GPS memory review</title>
  <style>
    body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #172026; background: #f7f8f9; }
    main { max-width: 1120px; margin: 0 auto; }
    h1, h2 { margin: 0 0 12px; }
    section { margin: 24px 0; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #d9dee3; }
    th, td { text-align: left; vertical-align: top; padding: 10px 12px; border-bottom: 1px solid #e8ecef; }
    th { font-size: 12px; text-transform: uppercase; color: #52616b; background: #f0f3f5; }
    code { white-space: pre-wrap; color: #0b5cad; }
    ul { background: white; border: 1px solid #d9dee3; padding: 14px 22px; }
    li { margin: 10px 0; }
    .muted { color: #697782; }
    .pill { display: inline-block; min-width: 52px; padding: 2px 6px; border-radius: 4px; color: white; text-align: center; font-size: 12px; }
    .high { background: #b42318; }
    .medium { background: #b54708; }
    .low { background: #475467; }
  </style>
</head>
<body>
<main>
  <h1>GPS memory review</h1>
  <p class="muted">${q.total} review item${q.total === 1 ? "" : "s"} generated ${esc(new Date().toISOString())}</p>
  <section>
    <h2>Next actions</h2>
    ${rows ? `<table><thead><tr><th>Priority</th><th>Symbol</th><th>Kind</th><th>Reason</th><th>Command</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No next actions.</p>"}
  </section>
  <section><h2>Promotions</h2>${promote ? `<ul>${promote}</ul>` : "<p>No promotion candidates.</p>"}</section>
  <section><h2>Stale memory</h2>${stale ? `<ul>${stale}</ul>` : "<p>No stale memory.</p>"}</section>
  <section><h2>Open questions</h2>${questions ? `<ul>${questions}</ul>` : "<p>No open questions.</p>"}</section>
</main>
</body>
</html>
`;
}

export function registerReviewMemory(program: Command): void {
  const cmd = program
      .command("review-memory")
      .description("Maintainer queue: approve, reject, or promote captured memories");

  addRootOption(
    cmd
      .command("list", { isDefault: true })
      .description("List promotions, stale entries, and open questions")
      .option("--days <n>", "Staleness threshold in days", (v) => parseInt(v, 10), 90)
      .option("--limit <n>", "Cap per section", (v) => parseInt(v, 10), 25)
      .option("--html", "Write a local HTML memory review")
      .option("--out <path>", "HTML output path (default: .gps/review/memory.html)")
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    const q = await buildReviewQueue(root, { days: opts.days, limit: opts.limit });
    if (opts.json) {
      console.log(JSON.stringify(q, null, 2));
      return;
    }
    if (opts.html) {
      const out = path.resolve(root, opts.out ?? ".gps/review/memory.html");
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, renderReviewHtml(q));
      console.log(kleur.green("memory review written: ") + path.relative(root, out));
      return;
    }
    if (q.total === 0) {
      console.log(kleur.green("✓ memory is clean — nothing to review"));
      return;
    }
    console.log(kleur.bold(`memory review queue (${q.total} items)`));

    if (q.items.length > 0) {
      console.log(kleur.cyan(`\nNext actions (${q.items.length})`));
      for (const item of q.items.slice(0, opts.limit)) {
        const color = item.priority === "high" ? kleur.red : item.priority === "medium" ? kleur.yellow : kleur.dim;
        console.log(`  ${color(`[${item.priority}]`)} ${kleur.bold(item.symbol)} ${kleur.dim(item.kind)}`);
        console.log(`    ${item.reason}`);
        console.log(`    ${kleur.cyan(item.command)}`);
      }
    }

    if (q.promote.length > 0) {
      console.log(kleur.cyan(`\nPromote (${q.promote.length}) — repeated notes ready to become invariants:`));
      for (const p of q.promote.slice(0, opts.limit)) {
        console.log(`  ${kleur.yellow(p.symbol)}  ${kleur.dim(`[${p.severity_hint}]`)}  ${p.representative_lesson}`);
        console.log(kleur.dim(`    ${p.notes.length} similar notes`));
      }
    }
    if (q.stale.length > 0) {
      console.log(kleur.cyan(`\nStale (${q.stale.length}) — entries older than ${opts.days}d whose file moved:`));
      for (const s of q.stale.slice(0, opts.limit)) {
        const flag = s.file_changed_since ? kleur.yellow("⚠") : " ";
        console.log(`  ${flag} ${kleur.dim(`${s.age_days}d`)}  ${kleur.cyan(s.kind)}  ${s.symbol}  ${kleur.dim(s.text.slice(0, 80))}`);
      }
    }
    if (q.open_questions.length > 0) {
      console.log(kleur.cyan(`\nOpen questions (${q.open_questions.length}):`));
      for (const oq of q.open_questions.slice(0, opts.limit)) {
        console.log(`  ${kleur.dim(`${oq.age_days}d`)}  ${kleur.cyan(oq.symbol)}  ${oq.question}`);
      }
    }
  });

  addRootOption(
    cmd
      .command("approve <id>")
      .description("Mark a captured note as human-verified trusted context")
      .option("--by <who>", "Reviewer identity"),
  ).action(async (id: string, opts: IdOpts) => {
    const root = resolveRoot(opts);
    const updated = await updateNoteById(root, id, {
      verified_by: opts.by ?? "human",
      verified_at: new Date().toISOString(),
      confidence: 1.0,
    });
    if (!updated) {
      console.log(kleur.red(`✗ note ${id} not found`));
      process.exitCode = 1;
      return;
    }
    console.log(kleur.green(`✓ approved ${id}`));
    console.log(kleur.dim(`  ${updated.path}`));
  });

  addRootOption(
    cmd
      .command("reject <id>")
      .description("Remove a captured note from memory")
  ).action(async (id: string, opts: RootOption) => {
    const root = resolveRoot(opts);
    const removed = await removeNoteById(root, id);
    if (!removed) {
      console.log(kleur.red(`✗ note ${id} not found`));
      process.exitCode = 1;
      return;
    }
    console.log(kleur.green(`✓ rejected ${id}`));
    console.log(kleur.dim(`  removed from ${removed.path}`));
  });

  addRootOption(
    cmd
      .command("promote <id>")
      .description("Move a note to a more durable scope")
      .requiredOption("--to <scope>", "global | symbol | file | feature | area")
      .option("--target <target>", "Required for symbol|file|feature|area"),
  ).action(async (id: string, opts: PromoteOpts) => {
    const root = resolveRoot(opts);
    try {
      const to = validScope(opts.to);
      if (!to) throw new Error("--to must be one of: global, symbol, file, feature, area");
      const result = await reclassifyLesson(root, {
        id,
        to_scope: to,
        to_target: opts.target,
      });
      console.log(kleur.green(`✓ promoted ${id} to ${result.to_scope}`));
      console.log(kleur.dim(`  ${result.path}`));
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}
