import { describe, expect, it } from "vitest";
import { DocHistory, type DocModel, type DocSnapshot } from "@invariance/gps-schemas";
import { renderHistoryHtml } from "./history_html_render.js";

function model(opts: { annotated?: boolean; mermaid?: boolean } = {}): DocModel {
  return {
    schema_version: 1,
    kind: "repo",
    title: "Change",
    generated_at: "2026-01-01T00:00:00.000Z",
    files: [
      {
        path: "src/a.ts",
        language: "typescript",
        status: "modified",
        diff: "@@ -1,1 +1,2 @@\n export const a = 1;\n+export const b = 2;",
        hunks: [{ file: "src/a.ts", start_line: 1, end_line: 2 }],
        annotations: opts.annotated
          ? [
              {
                file: "src/a.ts",
                start_line: 2,
                end_line: 2,
                text: "adds b",
                kind: "note",
                source: "agent",
              },
            ]
          : [],
        binary: false,
        truncated: false,
      },
    ],
    sections: opts.mermaid
      ? [{ id: "d", title: "Diagram", markdown: "```mermaid\ngraph TD;A-->B;\n```", kind: "mermaid" }]
      : [],
    annotations_unanchored: [],
  };
}

function snapshot(over: Partial<DocSnapshot>): DocSnapshot {
  return {
    schema_version: 1,
    event: "commit",
    captured_at: "2026-01-01T00:00:00.000Z",
    model: model(),
    pr_comments: [],
    labels: [],
    ...over,
  } as DocSnapshot;
}

function history(snapshots: DocSnapshot[]): DocHistory {
  return DocHistory.parse({ id: "repo-main", kind: "repo", title: "My PR", snapshots });
}

describe("renderHistoryHtml", () => {
  it("is self-contained (no external scripts or stylesheets)", () => {
    const html = renderHistoryHtml(history([snapshot({ ref: "aaaaaaa" }), snapshot({ ref: "bbbbbbb" })]));
    expect(html).toContain("<!doctype html>");
    expect(html).not.toContain("<script src");
    expect(html).not.toContain("<link ");
  });

  it("renders a scrubber and one .snap section per snapshot", () => {
    const html = renderHistoryHtml(
      history([snapshot({ ref: "aaaaaaa" }), snapshot({ ref: "bbbbbbb" }), snapshot({ ref: "ccccccc" })]),
    );
    expect(html).toContain('type="range"');
    expect(html).toContain('id="scrub"');
    expect((html.match(/class="snap"/g) ?? []).length).toBe(3);
    expect(html).toContain('data-idx="0"');
    expect(html).toContain('data-idx="2"');
  });

  it("embeds clickable annotations with line ranges", () => {
    const html = renderHistoryHtml(history([snapshot({ model: model({ annotated: true }) })]));
    expect(html).toContain('data-start="2"');
    expect(html).toContain('data-end="2"');
  });

  it("renders PR comments and labels, HTML-escaped", () => {
    const html = renderHistoryHtml(
      history([
        snapshot({
          event: "pr-regen",
          labels: ["<b>bug</b>"],
          pr_comments: [
            { author: "alice", body: "looks <good>", kind: "review", state: "APPROVED" },
          ],
        }),
      ]),
    );
    expect(html).toContain("alice");
    expect(html).toContain("APPROVED");
    expect(html).toContain("&lt;b&gt;bug&lt;/b&gt;");
    expect(html).toContain("looks &lt;good&gt;");
    expect(html).not.toContain("<b>bug</b>");
  });

  it("loads mermaid only when a snapshot uses it", () => {
    const without = renderHistoryHtml(history([snapshot({})]));
    expect(without).not.toContain("mermaid.esm.min.mjs");
    const withMermaid = renderHistoryHtml(history([snapshot({ model: model({ mermaid: true }) })]));
    expect(withMermaid).toContain("mermaid.esm.min.mjs");
  });

  it("omits diff bodies for snapshots beyond the full-snapshot window", () => {
    const snaps = [
      snapshot({ ref: "old" }),
      snapshot({ ref: "new" }),
    ];
    const html = renderHistoryHtml(history(snaps), { fullSnapshots: 1 });
    // Only the older snapshot's diff body is dropped; the newest keeps a table.
    expect((html.match(/Large change/g) ?? []).length).toBe(1);
    expect(html).toContain('<table class="code-table">');
  });
});
