import type { Command } from "commander";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import kleur from "kleur";
import {
  brief,
  buildDiffDocModel,
  buildPrDocModel,
  fetchPr,
  formatBriefMarkdown,
  ghAvailable,
  loadAllAreaNotes,
  loadAllDecisions,
  loadAllFeatureNotes,
  loadAllFileNotes,
  loadAllNotes,
  loadConfig,
  loadDocConfig,
  loadInbox,
  loadInvariants,
  loadPreferences,
  renderDocMarkdown,
  writeDocStore,
  type LlmAnnotator,
} from "@invariance/gps-core";
import { GpsLlm, annotateDiff } from "@invariance/gps-llm";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  pr?: string;
  base?: string;
  out?: string;
  diffView?: "unified" | "split";
  llm?: boolean;
  apiKey?: string;
  model?: string;
  json?: boolean;
  printMd?: boolean;
  maxDiffBytes?: string;
  serve?: boolean;
  host?: string;
  port?: string;
  experimentalLiveDocs?: boolean;
}

interface LiveDocModel {
  generated_at: string;
  base: string;
  experimental: true;
  brief: Awaited<ReturnType<typeof brief>>;
  inbox: {
    pending: number;
    risky: number;
    items: Array<{ id: string; kind: string; text: string; area?: string; risk_topics: string[] }>;
  };
  memory: {
    notes: number;
    invariants: number;
    decisions: number;
    preferences: number;
  };
}

export function registerDoc(program: Command): void {
  addRootOption(
    program
      .command("doc")
      .description("Generate shareable PR/local diff docs, or opt into experimental live docs")
      .option("--pr <number>", "Document a PR (uses `gh pr view` + `gh pr diff`)")
      .option("--base <ref>", "Document local working changes vs <ref> (default: HEAD)")
      .option("--out <path>", "Output directory for shareable docs, or HTML file for live docs")
      .option("--diff-view <mode>", "Diff layout: unified | split (default: unified)")
      .option("--no-llm", "Skip LLM gap-fill; only overlay captured notes")
      .option("--api-key <key>", "Anthropic API key (default: ANTHROPIC_API_KEY env)")
      .option("--model <id>", "Anthropic model ID (default: claude-opus-4-7)")
      .option("--max-diff-bytes <n>", "Omit per-file bodies when the raw diff exceeds this many bytes")
      .option("--print-md", "Also print the generated Markdown to stdout after writing files")
      .option("--serve", "Serve the experimental live doc over HTTP; regenerates on each request")
      .option("--host <host>", "HTTP host for --serve (default: 127.0.0.1)", "127.0.0.1")
      .option("--port <n>", "HTTP port for --serve (default: 17370)", "17370")
      .option(
        "--experimental-live-docs",
        "Enable experimental live docs for this run",
      )
      .option("--json", "Emit the generated model as JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    try {
      if (opts.experimentalLiveDocs || opts.serve) {
        await runLiveDocs(root, opts);
        return;
      }

      const cfg = await loadDocConfig(root);
      const llmFill = opts.llm !== false && cfg.llm_fill;
      const haveKey = !!(opts.apiKey ?? process.env.ANTHROPIC_API_KEY);
      const llm = new GpsLlm({
        apiKey: opts.apiKey,
        model: opts.model,
        dryRun: !llmFill || !haveKey,
      });
      const annotate: LlmAnnotator = async (reqs) =>
        (await annotateDiff(llm, reqs)).annotations;

      const buildOpts = {
        annotate,
        llmFill,
        maxDiffBytes: parsePositiveInt(opts.maxDiffBytes, "--max-diff-bytes") ?? cfg.max_diff_bytes,
      };

      let model;
      if (opts.pr) {
        if (!(await ghAvailable())) {
          throw new Error(
            "gh CLI not available. Install GitHub CLI, or use `--base <ref>` to document local changes.",
          );
        }
        const snap = await fetchPr(opts.pr);
        if (!snap) throw new Error(`failed to fetch PR #${opts.pr} via gh`);
        model = await buildPrDocModel(root, snap, buildOpts);
      } else {
        const base = opts.base ?? "HEAD";
        model = await buildDiffDocModel(root, base, buildOpts);
        if (model.files.length === 0) {
          console.error(kleur.yellow(`no changes vs ${base}. nothing to document.`));
          return;
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(model, null, 2));
        return;
      }

      const result = await writeDocStore(root, model, { out_dir: opts.out ?? cfg.out_dir });
      console.log(kleur.green("doc written:"));
      console.log(`  html: ${kleur.bold(result.htmlPath)}`);
      console.log(`  md:   ${result.mdPath}`);
      if (model.stats) {
        console.log(
          `  stats: ${model.stats.files_changed} files, +${model.stats.added_lines}/-${model.stats.deleted_lines}, ` +
            `${model.stats.annotations} annotations, ${model.stats.unannotated_hunks} unannotated hunks`,
        );
      }
      if (!haveKey && llmFill) {
        console.log(
          kleur.dim(
            "  (no ANTHROPIC_API_KEY: annotations are from captured notes only; set a key for LLM gap-fill)",
          ),
        );
      }
      if (opts.printMd) {
        console.log("");
        console.log(renderDocMarkdown(model));
      }
    } catch (err) {
      console.error(kleur.red(`error: ${(err as Error).message}`));
      process.exitCode = 1;
    }
  });
}

async function runLiveDocs(root: string, opts: Opts): Promise<void> {
  await assertLiveDocsEnabled(root, !!opts.experimentalLiveDocs);
  const base = opts.base ?? "HEAD";
  if (opts.serve) {
    const host = opts.host ?? "127.0.0.1";
    const port = parsePort(opts.port);
    const server = createServer(async (_req, res) => {
      try {
        const model = await buildLiveDoc(root, base);
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(renderLiveDocHtml(model));
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end((err as Error).message);
      }
    });
    server.listen(port, host, () => {
      console.log(kleur.green("experimental live docs running"));
      console.log(`  http://${host}:${port}/`);
      console.log(kleur.dim("  regenerates on refresh; Ctrl-C to stop"));
    });
    return;
  }

  const model = await buildLiveDoc(root, base);
  if (opts.json) {
    console.log(JSON.stringify(model, null, 2));
    return;
  }

  const out = opts.out ?? ".gps/docs/live.html";
  const outAbs = path.resolve(root, out);
  await mkdir(path.dirname(outAbs), { recursive: true });
  await writeFile(outAbs, renderLiveDocHtml(model));
  console.log(kleur.green("wrote experimental live doc ") + path.relative(root, outAbs));
}

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
  return n;
}

async function assertLiveDocsEnabled(root: string, flag: boolean): Promise<void> {
  const cfg = await loadConfig(root);
  if (flag || cfg.experimental.live_docs) return;
  throw new Error(
    "live docs are experimental. Re-run with --experimental-live-docs, or set experimental.live_docs: true in .gps/config.yml.",
  );
}

function parsePort(value: string | undefined): number {
  const n = Number(value ?? "17370");
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  return n;
}

async function buildLiveDoc(root: string, base: string): Promise<LiveDocModel> {
  const b = await brief(root, { base });
  const inbox = await loadInbox(root);
  const pending = inbox.filter((i) => i.status === "pending");
  const risky = pending.filter((i) => i.risk_topics.length > 0);
  const [symbolNotes, fileNotes, featureNotes, areaNotes, invariants, decisions, preferences] =
    await Promise.all([
      loadAllNotes(root),
      loadAllFileNotes(root),
      loadAllFeatureNotes(root),
      loadAllAreaNotes(root),
      loadInvariants(root),
      loadAllDecisions(root),
      loadPreferences(root),
    ]);
  const noteCount =
    symbolNotes.length +
    fileNotes.reduce((sum, entry) => sum + entry.notes.length, 0) +
    featureNotes.reduce((sum, entry) => sum + entry.notes.length, 0) +
    areaNotes.reduce((sum, entry) => sum + entry.notes.length, 0);

  return {
    generated_at: new Date().toISOString(),
    base,
    experimental: true,
    brief: b,
    inbox: {
      pending: pending.length,
      risky: risky.length,
      items: pending.slice(0, 20).map((i) => ({
        id: i.id,
        kind: i.kind,
        text: i.text,
        area: i.area,
        risk_topics: i.risk_topics,
      })),
    },
    memory: {
      notes: noteCount,
      invariants: invariants.length,
      decisions: decisions.length,
      preferences: preferences.length,
    },
  };
}

function renderLiveDocHtml(model: LiveDocModel): string {
  const briefMd = formatBriefMarkdown(model.brief);
  const changed = model.brief.changed_symbols
    .map((s) => `<li><code>${esc(s.qualified_name ?? s.name)}</code> <span>${esc(s.file)}:${s.line}</span></li>`)
    .join("");
  const notes = model.brief.notes
    .map((entry) => {
      const items = entry.notes
        .map((n) => `<li><strong>${esc(n.severity)}</strong> ${esc(n.lesson)}${n.evidence ? ` <em>${esc(n.evidence)}</em>` : ""}</li>`)
        .join("");
      return `<section><h3>${esc(entry.scope)}: <code>${esc(entry.target)}</code></h3><ul>${items}</ul></section>`;
    })
    .join("");
  const inbox = model.inbox.items
    .map((i) => `<li><code>${esc(i.id)}</code> <strong>${esc(i.kind)}</strong> ${esc(i.text)}${i.area ? ` <em>${esc(i.area)}</em>` : ""}${i.risk_topics.length ? ` <span class="risk">${esc(i.risk_topics.join(", "))}</span>` : ""}</li>`)
    .join("");
  const tests = model.brief.per_symbol
    .map((entry) => {
      const name = entry.symbol.qualified_name ?? entry.symbol.name;
      const files = entry.tests.length
        ? entry.tests.map((t) => `<code>${esc(t.file)}</code>`).join(", ")
        : `<span class="risk">no tests detected</span>`;
      return `<li><code>${esc(name)}</code> ${files}</li>`;
    })
    .join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GPS Live Docs</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f7f7f4; color: #171717; }
    header { padding: 24px 32px; background: #171717; color: white; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px 20px 48px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    h2 { margin-top: 32px; border-bottom: 1px solid #ddd; padding-bottom: 8px; }
    code { background: #eee; padding: 2px 5px; border-radius: 4px; }
    pre { white-space: pre-wrap; background: #111; color: #f4f4f4; padding: 16px; overflow: auto; border-radius: 8px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .card { background: white; border: 1px solid #e4e4df; border-radius: 8px; padding: 16px; }
    .metric { font-size: 26px; font-weight: 700; }
    .risk { color: #a11212; font-weight: 700; }
    .flag { display: inline-block; background: #ffe8b4; color: #3b2a00; padding: 4px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    ul { padding-left: 20px; }
    @media (max-width: 800px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  </style>
</head>
<body>
  <header>
    <span class="flag">EXPERIMENTAL - requires feature flag</span>
    <h1>GPS Live Docs</h1>
    <div>Generated ${esc(model.generated_at)} - base <code>${esc(model.base)}</code></div>
  </header>
  <main>
    <section class="grid">
      <div class="card"><div class="metric">${model.brief.changed_symbols.length}</div><div>changed symbols</div></div>
      <div class="card"><div class="metric">${model.memory.notes}</div><div>active notes</div></div>
      <div class="card"><div class="metric">${model.inbox.pending}</div><div>pending inbox${model.inbox.risky ? ` - <span class="risk">${model.inbox.risky} risky</span>` : ""}</div></div>
      <div class="card"><div class="metric">${model.brief.invariants.blocking_count}</div><div>blocking invariants</div></div>
    </section>
    <h2>Changed symbols</h2>
    <ul>${changed || "<li>No indexed changed symbols.</li>"}</ul>
    <h2>Relevant memory</h2>
    ${notes || "<p>No symbol/file/area notes surfaced for this diff.</p>"}
    <h2>Tests</h2>
    <ul>${tests || "<li>No changed symbols to map to tests.</li>"}</ul>
    <h2>Inbox review</h2>
    <ul>${inbox || "<li>No pending inbox items.</li>"}</ul>
    <h2>Full brief markdown</h2>
    <pre>${esc(briefMd)}</pre>
  </main>
</body>
</html>`;
}

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
