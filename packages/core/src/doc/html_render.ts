import type {
  DocModel,
  DocFileEntry,
  DocAnnotation,
  DocSection,
  DocLanguage,
} from "@invariance/gps-schemas";
import { highlightToHtml, escapeHtml } from "./highlight.js";

/**
 * Render a DocModel to a single self-contained HTML file: inline CSS + a small
 * vanilla-JS shim, no external assets, so it can be opened or shared by anyone.
 *
 * Dual-mode: a tabbed "Code" view (IDE-esque, syntax-highlighted diff with
 * line-range selection and annotation callouts) and a "Notes" view (rendered
 * prose with optional mermaid diagrams). The only optional network dependency
 * is mermaid, loaded from a CDN at view time *and* only when a mermaid block is
 * present — with the raw source always kept in a <details> fallback.
 */

export interface BrandPalette {
  saffron: string;
  bg: string;
}

const DEFAULT_BRAND: BrandPalette = { saffron: "#f4a020", bg: "#0e0d0a" };

interface RenderCtx {
  usedMermaid: boolean;
}

export function renderDocHtml(model: DocModel, brand: BrandPalette = DEFAULT_BRAND): string {
  const ctx: RenderCtx = { usedMermaid: false };
  const proseHtml = model.sections.length
    ? model.sections.map((s) => renderSection(s, ctx)).join("\n")
    : `<p class="empty">No prose notes for this doc.</p>`;
  const filesHtml = model.files.length
    ? model.files.map((f, i) => renderFileBlock(f, i)).join("\n")
    : `<p class="empty">No file changes.</p>`;
  const fileList = model.files
    .map(
      (f, i) =>
        `<li><a href="#file-${i}" data-target="file-${i}">${escapeHtml(f.path)}` +
        `<span class="badge badge-${f.status}">${f.status}</span></a></li>`,
    )
    .join("");

  const meta: string[] = [];
  if (model.pr) meta.push(`PR #${model.pr.number}`);
  if (model.base) meta.push(`base: ${escapeHtml(model.base)}`);
  meta.push(`generated ${escapeHtml(model.generated_at)}`);
  const statsHtml = model.stats ? renderStats(model.stats) : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(model.title)}</title>
<style>${css(brand)}</style>
</head>
<body>
<header class="top">
  <div class="brand">gps<span class="dot">.</span>doc</div>
  <div class="titles">
    <h1>${escapeHtml(model.title)}</h1>
    ${model.subtitle ? `<p class="subtitle">${escapeHtml(model.subtitle)}</p>` : ""}
    <p class="meta">${meta.join(" · ")}</p>
  </div>
  <nav class="tabs">
    <button class="tab active" data-view="code">Code</button>
    <button class="tab" data-view="notes">Notes</button>
  </nav>
</header>

<main>
  ${statsHtml}
  <section id="view-code" class="view active">
    <aside class="sidebar">
      <h2>Files</h2>
      <ul class="filelist">${fileList || "<li class=\"empty\">none</li>"}</ul>
    </aside>
    <div class="filebodies">${filesHtml}</div>
  </section>

  <section id="view-notes" class="view">
    <article class="prose">${proseHtml}</article>
  </section>
</main>

<script>${clientJs()}</script>
${ctx.usedMermaid ? mermaidScript() : ""}
</body>
</html>
`;
}

function renderStats(stats: NonNullable<DocModel["stats"]>): string {
  const tiles: Array<[string, string]> = [
    ["Files", String(stats.files_changed)],
    ["Lines", `+${stats.added_lines}/-${stats.deleted_lines}`],
    ["Annotations", String(stats.annotations)],
    ["Unannotated", String(stats.unannotated_hunks)],
  ];
  if (stats.high_severity_annotations) tiles.push(["High severity", String(stats.high_severity_annotations)]);
  if (stats.truncated_files) tiles.push(["Omitted", String(stats.truncated_files)]);
  return `<section class="stats">${tiles
    .map(([label, value]) => `<div class="stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("")}</section>`;
}

function renderFileBlock(f: DocFileEntry, idx: number): string {
  const L: string[] = [];
  L.push(`<section class="doc-file" id="file-${idx}">`);
  L.push(
    `<div class="file-head"><code>${escapeHtml(f.path)}</code>` +
      `<span class="badge badge-${f.status}">${f.status}</span>` +
      (f.language !== "other" ? `<span class="lang">${f.language}</span>` : "") +
      `</div>`,
  );

  if (f.binary) {
    L.push(`<p class="empty">Binary file — not rendered.</p>`);
    L.push(`</section>`);
    return L.join("\n");
  }
  if (f.truncated) {
    L.push(`<p class="empty">Large change — diff omitted to keep this file shareable.</p>`);
    L.push(`</section>`);
    return L.join("\n");
  }

  const sorted = [...f.annotations].sort((a, b) => a.start_line - b.start_line);
  if (sorted.length) {
    L.push(`<div class="annotations">`);
    for (const a of sorted) {
      L.push(renderAnnotationCard(a));
    }
    L.push(`</div>`);
  }

  // Lines covered by an annotation get a saffron gutter so the reader sees at a
  // glance which code carries a note.
  const annotated = new Set<number>();
  for (const a of sorted) {
    for (let n = a.start_line; n <= a.end_line; n++) annotated.add(n);
  }

  if (f.diff) {
    L.push(renderDiffTable(f.diff, f.language, annotated));
  } else if (f.after) {
    L.push(renderSourceTable(f.after, f.language, annotated));
  }
  L.push(`</section>`);
  return L.join("\n");
}

function renderAnnotationCard(a: DocAnnotation): string {
  const r = a.start_line === a.end_line ? `L${a.start_line}` : `L${a.start_line}–${a.end_line}`;
  const sev = a.severity ? ` sev-${a.severity}` : "";
  return (
    `<button class="ann kind-${a.kind}${sev}" data-start="${a.start_line}" data-end="${a.end_line}">` +
    `<span class="ann-range">${r}</span>` +
    `<span class="ann-kind">${a.kind}</span>` +
    `<span class="ann-text">${escapeHtml(a.text)}</span>` +
    `</button>`
  );
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** Render a unified-diff segment as a line-numbered, highlighted table. */
function renderDiffTable(diff: string, lang: DocLanguage, annotated: Set<number>): string {
  const rows: string[] = [];
  let newLine = 0;
  for (const l of diff.split("\n")) {
    const hh = HUNK_HEADER.exec(l);
    if (hh) {
      newLine = Number(hh[1]);
      rows.push(
        `<tr class="row-hunk"><td class="ln"></td><td class="code">${escapeHtml(l)}</td></tr>`,
      );
      continue;
    }
    if (
      l.startsWith("diff --git") ||
      l.startsWith("index ") ||
      l.startsWith("--- ") ||
      l.startsWith("+++ ") ||
      l.startsWith("new file mode") ||
      l.startsWith("deleted file mode") ||
      l.startsWith("rename ") ||
      l.startsWith("similarity ") ||
      l.startsWith("\\ No newline")
    ) {
      continue;
    }
    if (l.startsWith("+")) {
      rows.push(row("add", newLine, l.slice(1), lang, annotated.has(newLine)));
      newLine++;
    } else if (l.startsWith("-")) {
      rows.push(row("del", null, l.slice(1), lang, false));
    } else if (l.startsWith(" ") || l === "") {
      rows.push(row("ctx", newLine, l.slice(1), lang, annotated.has(newLine)));
      newLine++;
    }
  }
  return `<table class="code-table">${rows.join("")}</table>`;
}

/** Render full source (non-diff repo view) as a numbered, highlighted table. */
function renderSourceTable(src: string, lang: DocLanguage, annotated: Set<number>): string {
  const rows = src.split("\n").map((line, i) => row("ctx", i + 1, line, lang, annotated.has(i + 1)));
  return `<table class="code-table">${rows.join("")}</table>`;
}

function row(
  type: "add" | "del" | "ctx",
  lineNo: number | null,
  text: string,
  lang: DocLanguage,
  isAnnotated: boolean,
): string {
  const cls = `row-${type}${isAnnotated ? " row-annotated" : ""}`;
  const data = lineNo !== null ? ` data-line="${lineNo}"` : "";
  const ln = lineNo !== null ? String(lineNo) : "";
  const sign = type === "add" ? "+" : type === "del" ? "-" : " ";
  return (
    `<tr class="${cls}"${data}>` +
    `<td class="ln">${ln}</td>` +
    `<td class="code"><span class="sign">${sign}</span>${highlightToHtml(text, lang)}</td>` +
    `</tr>`
  );
}

function renderSection(s: DocSection, ctx: RenderCtx): string {
  return `<section class="doc-section"><h2>${escapeHtml(s.title)}</h2>${mdToHtml(s.markdown, ctx)}</section>`;
}

/**
 * Minimal, safe Markdown → HTML. Input is gps-generated (controlled), so this
 * covers headings, lists, fenced code (incl. mermaid), inline code, bold,
 * italic, and links — everything escaped first. Not a general-purpose parser.
 */
export function mdToHtml(md: string, ctx: RenderCtx): string {
  const out: string[] = [];
  const lines = md.split("\n");
  let i = 0;
  let listOpen: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listOpen) {
      out.push(`</${listOpen}>`);
      listOpen = null;
    }
  };

  const at = (n: number): string => lines[n] ?? "";

  while (i < lines.length) {
    const line = at(i);

    // Fenced code block.
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      closeList();
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(at(i))) {
        body.push(at(i));
        i++;
      }
      i++; // skip closing fence
      const code = body.join("\n");
      if (lang === "mermaid") {
        ctx.usedMermaid = true;
        out.push(
          `<div class="mermaid-wrap"><pre class="mermaid">${escapeHtml(code)}</pre>` +
            `<details><summary>diagram source</summary><pre class="raw">${escapeHtml(code)}</pre></details></div>`,
        );
      } else {
        out.push(`<pre class="block"><code>${escapeHtml(code)}</code></pre>`);
      }
      continue;
    }

    // Heading.
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = Math.min(6, (h[1] ?? "").length + 1); // section already owns <h2>
      out.push(`<h${level}>${inline(h[2] ?? "")}</h${level}>`);
      i++;
      continue;
    }

    // List items.
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      const want: "ul" | "ol" = ul ? "ul" : "ol";
      if (listOpen && listOpen !== want) closeList();
      if (!listOpen) {
        listOpen = want;
        out.push(`<${want}>`);
      }
      out.push(`<li>${inline((ul ?? ol)?.[1] ?? "")}</li>`);
      i++;
      continue;
    }

    // Blank line.
    if (line.trim() === "") {
      closeList();
      i++;
      continue;
    }

    // Paragraph (gather consecutive non-empty, non-structural lines).
    closeList();
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      at(i).trim() !== "" &&
      !/^```/.test(at(i)) &&
      !/^#{1,6}\s/.test(at(i)) &&
      !/^[-*]\s/.test(at(i)) &&
      !/^\d+\.\s/.test(at(i))
    ) {
      para.push(at(i));
      i++;
    }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  closeList();
  return out.join("\n");
}

/** Inline markdown: escape first, then apply code/bold/italic/link. */
function inline(s: string): string {
  let t = escapeHtml(s);
  // inline code first so its contents aren't re-formatted
  t = t.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => {
    const safe = /^(https?:|mailto:|#|\/|\.)/.test(href) ? href : "#";
    return `<a href="${safe}" rel="noopener noreferrer">${text}</a>`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return t;
}

function css(brand: BrandPalette): string {
  return `
:root{--saffron:${brand.saffron};--bg:${brand.bg};--panel:#17151140;--surface:#1a1814;--line:#2a2620;--text:#ece7df;--dim:#9a9388;--add:#1f3a1f;--addbar:#3fae5a;--del:#3a1f1f;--delbar:#e0564e;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
code,pre,.code-table{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:20px;padding:14px 22px;background:#0b0a08ee;border-bottom:1px solid var(--line);backdrop-filter:blur(8px)}
.brand{font-weight:700;letter-spacing:.5px;color:var(--saffron)}
.brand .dot{color:var(--text)}
.titles{flex:1;min-width:0}
.titles h1{margin:0;font-size:17px;font-weight:650}
.subtitle{margin:2px 0 0;color:var(--dim)}
.meta{margin:2px 0 0;color:var(--dim);font-size:12px}
.tabs{display:flex;gap:6px}
.tab{background:transparent;border:1px solid var(--line);color:var(--dim);padding:6px 14px;border-radius:7px;cursor:pointer;font-size:13px}
.tab:hover{color:var(--text)}
.tab.active{background:var(--saffron);border-color:var(--saffron);color:#1a1206;font-weight:600}
main{max-width:1200px;margin:0 auto;padding:18px 22px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px}
.stat{border:1px solid var(--line);background:var(--surface);border-radius:8px;padding:10px 12px}
.stat span{display:block;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.6px}
.stat strong{display:block;margin-top:2px;font-size:18px;font-weight:650;color:var(--text)}
.view{display:none}
.view.active{display:block}
#view-code.active{display:grid;grid-template-columns:230px 1fr;gap:20px;align-items:start}
.sidebar{position:sticky;top:84px}
.sidebar h2{font-size:12px;text-transform:uppercase;letter-spacing:.7px;color:var(--dim);margin:0 0 8px}
.filelist{list-style:none;margin:0;padding:0}
.filelist a{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:5px 8px;border-radius:6px;color:var(--text);text-decoration:none;font-size:12.5px;word-break:break-all}
.filelist a:hover{background:var(--surface)}
.badge{font-size:10px;text-transform:uppercase;letter-spacing:.5px;padding:1px 6px;border-radius:5px;border:1px solid var(--line);color:var(--dim);flex:none}
.badge-added{color:var(--addbar);border-color:#2c5a35}
.badge-deleted{color:var(--delbar);border-color:#6a2c2c}
.badge-renamed{color:var(--saffron);border-color:#6a4e1c}
.doc-file{border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:20px;background:var(--surface)}
.file-head{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#100e0b;border-bottom:1px solid var(--line)}
.file-head code{color:var(--text);font-size:13px}
.file-head .lang{margin-left:auto;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.annotations{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border-bottom:1px solid var(--line)}
.ann{display:flex;gap:10px;align-items:baseline;text-align:left;background:#13110d;border:1px solid var(--line);border-left:3px solid var(--saffron);border-radius:7px;padding:7px 10px;color:var(--text);cursor:pointer;font:inherit}
.ann:hover{border-color:var(--saffron)}
.ann.kind-llm{border-left-color:#5aa0e0}
.ann.kind-decision{border-left-color:#b48be0}
.ann.sev-high{border-left-color:var(--delbar)}
.ann-range{flex:none;color:var(--saffron);font-family:ui-monospace,monospace;font-size:12px;min-width:64px}
.ann.kind-llm .ann-range{color:#5aa0e0}
.ann-kind{flex:none;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim)}
.ann-text{flex:1}
.code-table{width:100%;border-collapse:collapse;font-size:12.5px}
.code-table td{padding:0 8px;white-space:pre;vertical-align:top}
.code-table .ln{width:1%;text-align:right;color:#5f594e;user-select:none;border-right:1px solid var(--line);background:#100e0b}
.code-table .code{width:100%}
.code-table .sign{color:#5f594e;margin-right:2px}
.row-add{background:var(--add)}
.row-add .sign{color:var(--addbar)}
.row-del{background:var(--del)}
.row-del .sign{color:var(--delbar)}
.row-hunk td{color:var(--dim);background:#0e0c09;font-size:11.5px}
.row-annotated .ln{box-shadow:inset 3px 0 0 var(--saffron)}
.row-selected{background:#3a3206 !important}
.tok-kw{color:#e0a35a}
.tok-str{color:#9ed08a}
.tok-com{color:#6f6a5f;font-style:italic}
.tok-num{color:#d18ad0}
.prose{max-width:780px}
.doc-section h2{color:var(--saffron);border-bottom:1px solid var(--line);padding-bottom:6px}
.prose a{color:var(--saffron)}
.prose code{background:#13110d;padding:1px 5px;border-radius:4px}
.prose pre.block{background:#100e0b;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto}
.prose pre.block code{background:none;padding:0}
.mermaid-wrap{margin:14px 0}
.mermaid-wrap details{margin-top:6px;color:var(--dim)}
.mermaid-wrap summary{cursor:pointer}
.empty{color:var(--dim);font-style:italic;padding:10px 0}
@media(max-width:760px){#view-code.active{grid-template-columns:1fr}.sidebar{position:static}}
`;
}

function clientJs(): string {
  return `
(function(){
  // Tab switching.
  document.querySelectorAll('.tab').forEach(function(btn){
    btn.addEventListener('click',function(){
      document.querySelectorAll('.tab').forEach(function(b){b.classList.remove('active')});
      document.querySelectorAll('.view').forEach(function(v){v.classList.remove('active')});
      btn.classList.add('active');
      var v=document.getElementById('view-'+btn.dataset.view);
      if(v)v.classList.add('active');
    });
  });
  // Annotation -> highlight + scroll to its line range within the same file.
  document.querySelectorAll('.ann').forEach(function(ann){
    ann.addEventListener('click',function(){
      var file=ann.closest('.doc-file');
      if(!file)return;
      var start=+ann.dataset.start, end=+ann.dataset.end;
      file.querySelectorAll('tr.row-selected').forEach(function(r){r.classList.remove('row-selected')});
      var first=null;
      file.querySelectorAll('tr[data-line]').forEach(function(tr){
        var n=+tr.dataset.line;
        if(n>=start&&n<=end){tr.classList.add('row-selected');if(!first)first=tr;}
      });
      if(first)first.scrollIntoView({behavior:'smooth',block:'center'});
    });
  });
})();
`;
}

function mermaidScript(): string {
  // Loaded only when a mermaid block exists; the raw source stays in <details>
  // so the doc is still useful offline.
  return `<script type="module">
try{
  const m=await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
  m.default.initialize({startOnLoad:true,theme:'dark'});
}catch(e){/* offline: raw diagram source remains in <details> */}
</script>`;
}
