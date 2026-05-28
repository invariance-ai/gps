import type { Command } from "commander";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import kleur from "kleur";
import {
  brief,
  formatBriefMarkdown,
  loadAllAreaNotes,
  loadAllDecisions,
  loadAllFeatureNotes,
  loadAllFileNotes,
  loadAllNotes,
  loadConfig,
  loadInbox,
  loadInvariants,
  loadPreferences,
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface DocOpts extends RootOption {
  base?: string;
  out?: string;
  serve?: boolean;
  host?: string;
  port?: string;
  experimentalLiveDocs?: boolean;
  json?: boolean;
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
      .description("[experimental] Generate or serve live HTML documentation for the current diff")
      .option("--base <ref>", "Diff base for the live doc (default: HEAD)", "HEAD")
      .option("--out <file>", "HTML output path (default: .gps/docs/live.html)")
      .option("--serve", "Serve the live doc over HTTP; regenerates on each request")
      .option("--host <host>", "HTTP host for --serve (default: 127.0.0.1)", "127.0.0.1")
      .option("--port <n>", "HTTP port for --serve (default: 17370)", "17370")
      .option(
        "--experimental-live-docs",
        "Required unless .gps/config.yml has experimental.live_docs: true",
      )
      .option("--json", "Emit the live doc model as JSON"),
  ).action(async (opts: DocOpts) => {
    const root = resolveRoot(opts);
    try {
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
    } catch (err) {
      console.error(kleur.red(`error: ${(err as Error).message}`));
      process.exitCode = 1;
    }
  });
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
    <span class="flag">EXPERIMENTAL · requires feature flag</span>
    <h1>GPS Live Docs</h1>
    <div>Generated ${esc(model.generated_at)} · base <code>${esc(model.base)}</code></div>
  </header>
  <main>
    <section class="grid">
      <div class="card"><div class="metric">${model.brief.changed_symbols.length}</div><div>changed symbols</div></div>
      <div class="card"><div class="metric">${model.memory.notes}</div><div>active notes</div></div>
      <div class="card"><div class="metric">${model.inbox.pending}</div><div>pending inbox${model.inbox.risky ? ` · <span class="risk">${model.inbox.risky} risky</span>` : ""}</div></div>
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
