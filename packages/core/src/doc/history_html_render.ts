import type { DocHistory, DocModel, DocPrComment, DocSnapshot } from "@invariance/gps-schemas";
import { escapeHtml } from "./highlight.js";
import {
  css,
  DEFAULT_BRAND,
  mermaidScript,
  renderDocBody,
  type BrandPalette,
  type RenderCtx,
} from "./html_render.js";

/**
 * Render a DocHistory to a single self-contained HTML file with a **time
 * scrubber**: a slider/dropdown that steps between snapshots so a reader can
 * replay what the code, annotations, PR comments and labels looked like at each
 * commit / event.
 *
 * Every snapshot's body is rendered server-side (reusing `renderDocBody` with a
 * per-snapshot id prefix) and only the active one is shown — no client-side
 * re-rendering, so the file stays a pure, shareable artifact. The on-disk
 * `snap-*.json` files remain the machine-readable view; we deliberately do not
 * also embed the full JSON here, to avoid doubling the payload.
 */

export interface HistoryRenderOpts {
  brand?: BrandPalette;
  /** Keep full diff bodies for only the latest K snapshots (older ones omit the
   *  diff but keep stats, annotations and comments). Default: 20. */
  fullSnapshots?: number;
}

const DEFAULT_FULL_SNAPSHOTS = 20;

export function renderHistoryHtml(history: DocHistory, opts: HistoryRenderOpts = {}): string {
  const brand = opts.brand ?? DEFAULT_BRAND;
  const fullK = opts.fullSnapshots ?? DEFAULT_FULL_SNAPSHOTS;
  const ctx: RenderCtx = { usedMermaid: false };

  const snaps = history.snapshots;
  const n = snaps.length;
  const activeIdx = n > 0 ? n - 1 : 0;
  const firstFull = Math.max(0, n - fullK);

  const sections =
    n === 0
      ? `<p class="empty">No snapshots captured yet.</p>`
      : snaps
          .map((snap, i) => {
            const model = i >= firstFull ? snap.model : stripDiffBodies(snap.model);
            const body = renderDocBody(model, ctx, `s${i}-`);
            const prPanel = renderPrPanel(snap);
            return (
              `<section class="snap" data-idx="${i}"${i === activeIdx ? "" : " hidden"}>` +
              prPanel +
              body +
              `</section>`
            );
          })
          .join("\n");

  const options = snaps
    .map((s, i) => `<option value="${i}"${i === activeIdx ? " selected" : ""}>${escapeHtml(tick(s, i))}</option>`)
    .join("");

  const meta: string[] = [];
  if (history.pr_number) meta.push(`PR #${history.pr_number}`);
  meta.push(`${n} snapshot${n === 1 ? "" : "s"}`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(history.title)} · history</title>
<style>${css(brand)}${historyCss()}</style>
</head>
<body>
<header class="top">
  <div class="brand">gps<span class="dot">.</span>doc<span class="hist">history</span></div>
  <div class="titles">
    <h1>${escapeHtml(history.title)}</h1>
    <p class="meta">${meta.join(" · ")}</p>
  </div>
  <nav class="tabs">
    <button class="tab active" data-view="code">Code</button>
    <button class="tab" data-view="notes">Notes</button>
  </nav>
</header>

<div class="scrubber">
  <button class="step" id="prev" aria-label="Previous snapshot">‹</button>
  <input type="range" id="scrub" min="0" max="${Math.max(0, n - 1)}" value="${activeIdx}" step="1" ${n <= 1 ? "disabled" : ""}>
  <button class="step" id="next" aria-label="Next snapshot">›</button>
  <select id="snapsel" ${n <= 1 ? "disabled" : ""}>${options}</select>
  <span class="snaplabel" id="snaplabel"></span>
</div>

<main>
  ${sections}
</main>

<script>${historyClientJs()}</script>
${ctx.usedMermaid ? mermaidScript() : ""}
</body>
</html>
`;
}

/** Strip per-file diff bodies (keeps annotations + stats) for older snapshots. */
function stripDiffBodies(model: DocModel): DocModel {
  return {
    ...model,
    files: model.files.map((f) => ({ ...f, diff: undefined, after: undefined, truncated: true })),
  };
}

/** Scrubber tick label for a snapshot. */
function tick(s: DocSnapshot, i: number): string {
  const when = (s.commit?.date ?? s.captured_at).slice(0, 10);
  const ref = s.ref ? ` ${s.ref}` : "";
  const label = s.event === "commit" ? firstLine(s.commit?.message ?? "") : s.event;
  return `${i + 1}.${ref} · ${s.event === "commit" ? when : s.event}${label ? ` — ${truncate(label, 48)}` : ""}`;
}

function renderPrPanel(snap: DocSnapshot): string {
  const parts: string[] = [];
  const labels = snap.labels.length
    ? `<div class="labels">${snap.labels
        .map((l) => `<span class="label">${escapeHtml(l)}</span>`)
        .join("")}</div>`
    : "";
  const comments = snap.pr_comments.length
    ? `<div class="comments">${snap.pr_comments.map(renderComment).join("")}</div>`
    : "";
  const commitLine = snap.commit
    ? `<div class="commit-meta"><code>${escapeHtml(snap.ref ?? "")}</code> ` +
      `${escapeHtml(snap.commit.author)} · ${escapeHtml(snap.commit.date.slice(0, 10))}</div>`
    : "";
  if (!labels && !comments && !commitLine) return "";
  parts.push(`<div class="pr-panel">`);
  parts.push(
    `<div class="pr-head"><span class="pr-event pr-event-${snap.event}">${escapeHtml(snap.event)}</span>` +
      `<span class="pr-when">${escapeHtml(snap.captured_at.slice(0, 19).replace("T", " "))}</span></div>`,
  );
  if (commitLine) parts.push(commitLine);
  if (labels) parts.push(labels);
  if (comments) parts.push(comments);
  parts.push(`</div>`);
  return parts.join("");
}

function renderComment(c: DocPrComment): string {
  const tag = c.kind === "review" && c.state ? `${c.kind} · ${c.state}` : c.kind;
  return (
    `<div class="comment"><div class="comment-head"><strong>${escapeHtml(c.author)}</strong>` +
    `<span class="comment-kind">${escapeHtml(tag)}</span></div>` +
    `<div class="comment-body">${escapeHtml(c.body)}</div></div>`
  );
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? "").trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function historyCss(): string {
  return `
.brand .hist{margin-left:8px;font-size:11px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.6px}
.scrubber{position:sticky;top:60px;z-index:4;display:flex;align-items:center;gap:12px;padding:10px 22px;background:#0b0a08ee;border-bottom:1px solid var(--line);backdrop-filter:blur(8px)}
.scrubber input[type=range]{flex:1;min-width:120px;accent-color:var(--saffron)}
.scrubber .step{background:var(--surface);border:1px solid var(--line);color:var(--text);width:30px;height:30px;border-radius:7px;cursor:pointer;font-size:16px;line-height:1}
.scrubber .step:hover{border-color:var(--saffron)}
.scrubber select{background:var(--surface);border:1px solid var(--line);color:var(--text);padding:6px 8px;border-radius:7px;max-width:42%;font:inherit}
.snaplabel{color:var(--dim);font-size:12px;white-space:nowrap}
.snap[hidden]{display:none!important}
.pr-panel{border:1px solid var(--line);background:var(--surface);border-radius:10px;padding:12px 14px;margin-bottom:18px}
.pr-head{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.pr-event{font-size:10px;text-transform:uppercase;letter-spacing:.5px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--saffron)}
.pr-event-pr-merge{color:#b48be0;border-color:#6a4e1c}
.pr-when{color:var(--dim);font-size:12px}
.commit-meta{color:var(--dim);font-size:12px;margin-bottom:6px}
.commit-meta code{color:var(--saffron)}
.labels{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.label{font-size:11px;padding:2px 9px;border-radius:999px;background:#13110d;border:1px solid var(--line);color:var(--text)}
.comments{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.comment{border:1px solid var(--line);border-left:3px solid #5aa0e0;border-radius:7px;padding:8px 10px;background:#13110d}
.comment-head{display:flex;gap:8px;align-items:baseline;margin-bottom:4px}
.comment-kind{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim)}
.comment-body{white-space:pre-wrap;color:var(--text)}
@media(max-width:760px){.scrubber{flex-wrap:wrap}.scrubber select{max-width:100%}}
`;
}

function historyClientJs(): string {
  return `
(function(){
  var snaps=Array.prototype.slice.call(document.querySelectorAll('.snap'));
  var scrub=document.getElementById('scrub');
  var sel=document.getElementById('snapsel');
  var label=document.getElementById('snaplabel');
  var prev=document.getElementById('prev');
  var next=document.getElementById('next');
  var cur=snaps.length?snaps.length-1:0;

  function show(idx){
    if(idx<0)idx=0; if(idx>snaps.length-1)idx=snaps.length-1;
    cur=idx;
    snaps.forEach(function(s){ s.hidden = (+s.dataset.idx)!==idx; });
    if(scrub)scrub.value=idx;
    if(sel)sel.value=idx;
    if(label&&sel&&sel.options[idx])label.textContent=sel.options[idx].textContent;
  }
  if(scrub)scrub.addEventListener('input',function(){show(+scrub.value)});
  if(sel)sel.addEventListener('change',function(){show(+sel.value)});
  if(prev)prev.addEventListener('click',function(){show(cur-1)});
  if(next)next.addEventListener('click',function(){show(cur+1)});

  // Tabs apply across all snapshots so the chosen view survives scrubbing.
  document.querySelectorAll('.tab').forEach(function(btn){
    btn.addEventListener('click',function(){
      var view=btn.dataset.view;
      document.querySelectorAll('.tab').forEach(function(b){b.classList.remove('active')});
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach(function(v){v.classList.remove('active')});
      document.querySelectorAll('.view-'+view).forEach(function(v){v.classList.add('active')});
    });
  });

  // Annotation -> highlight + scroll within its own file (works per snapshot).
  document.querySelectorAll('.ann').forEach(function(ann){
    ann.addEventListener('click',function(){
      var file=ann.closest('.doc-file');
      if(!file)return;
      var start=+ann.dataset.start, end=+ann.dataset.end;
      file.querySelectorAll('tr.row-selected').forEach(function(r){r.classList.remove('row-selected')});
      var first=null;
      file.querySelectorAll('tr[data-line]').forEach(function(tr){
        var nn=+tr.dataset.line;
        if(nn>=start&&nn<=end){tr.classList.add('row-selected');if(!first)first=tr;}
      });
      if(first)first.scrollIntoView({behavior:'smooth',block:'center'});
    });
  });

  show(cur);
})();
`;
}
