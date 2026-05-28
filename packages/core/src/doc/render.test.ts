import { describe, it, expect } from "vitest";
import type { DocModel } from "@invariance/gps-schemas";
import { renderDocMarkdown } from "./md_render.js";
import { renderDocHtml } from "./html_render.js";

function fixture(overrides: Partial<DocModel> = {}): DocModel {
  return {
    schema_version: 1,
    kind: "pr",
    title: "Add retry to fetchUser",
    subtitle: "PR #42",
    generated_at: "2026-05-27T00:00:00.000Z",
    pr: { number: 42, title: "Add retry to fetchUser", body: "Adds **retry** with backoff." },
    files: [
      {
        path: "src/user.ts",
        language: "typescript",
        status: "modified",
        diff: [
          "diff --git a/src/user.ts b/src/user.ts",
          "--- a/src/user.ts",
          "+++ b/src/user.ts",
          "@@ -14,2 +14,4 @@",
          " const u = await get();",
          "+  // retry once",
          "+  if (!u) return get();",
          " return u;",
        ].join("\n"),
        hunks: [{ file: "src/user.ts", start_line: 14, end_line: 17 }],
        annotations: [
          {
            file: "src/user.ts",
            start_line: 14,
            end_line: 17,
            text: "Retries the fetch once on a null result.",
            kind: "note",
            severity: "medium",
            source: "human",
            symbol: "fetchUser",
          },
        ],
        binary: false,
        truncated: false,
      },
    ],
    sections: [
      { id: "description", title: "Description", markdown: "Adds **retry** with backoff.", kind: "narrative" },
    ],
    annotations_unanchored: [],
    ...overrides,
  };
}

describe("renderDocMarkdown", () => {
  it("renders title, prose, annotations, and a fenced diff", () => {
    const md = renderDocMarkdown(fixture());
    expect(md).toContain("# Add retry to fetchUser");
    expect(md).toContain("## Description");
    expect(md).toContain("**lines 14-17**");
    expect(md).toContain("Retries the fetch once");
    expect(md).toContain("```diff");
  });

  it("notes binary and truncated files without a code block", () => {
    const md = renderDocMarkdown(
      fixture({
        files: [
          { path: "x.png", language: "other", status: "modified", hunks: [], annotations: [], binary: true, truncated: false },
        ],
      }),
    );
    expect(md).toContain("Binary file");
    expect(md).not.toContain("```diff");
  });
});

describe("renderDocHtml", () => {
  it("is self-contained: no external scripts/styles when no mermaid", () => {
    const html = renderDocHtml(fixture());
    expect(html).not.toContain("<script src");
    expect(html).not.toContain("<link ");
    expect(html).not.toContain("cdn.jsdelivr.net");
  });

  it("includes the brand palette inline", () => {
    const html = renderDocHtml(fixture());
    expect(html).toContain("#f4a020");
    expect(html).toContain("#0e0d0a");
  });

  it("renders both tabs and a clickable annotation with data-start/data-end", () => {
    const html = renderDocHtml(fixture());
    expect(html).toContain('data-view="code"');
    expect(html).toContain('data-view="notes"');
    expect(html).toContain('data-start="14"');
    expect(html).toContain('data-end="17"');
  });

  it("highlights diff rows and marks annotated lines", () => {
    const html = renderDocHtml(fixture());
    expect(html).toContain("row-add");
    expect(html).toContain("row-annotated");
    expect(html).toContain('data-line="14"');
  });

  it("loads mermaid from CDN only when a mermaid section is present", () => {
    const withMermaid = fixture({
      sections: [
        { id: "diagram", title: "Flow", markdown: "```mermaid\ngraph TD; A-->B\n```", kind: "mermaid" },
      ],
    });
    const html = renderDocHtml(withMermaid);
    expect(html).toContain("cdn.jsdelivr.net");
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain("diagram source"); // offline fallback
  });

  it("escapes HTML from a malicious PR body/annotation", () => {
    const evil = fixture({
      sections: [
        { id: "d", title: "Description", markdown: "<script>alert(1)</script>", kind: "narrative" },
      ],
    });
    const html = renderDocHtml(evil);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("still renders a truncated file as a notice", () => {
    const html = renderDocHtml(
      fixture({
        files: [
          { path: "big.ts", language: "typescript", status: "modified", hunks: [], annotations: [], binary: false, truncated: true },
        ],
      }),
    );
    expect(html).toContain("Large change");
  });
});
