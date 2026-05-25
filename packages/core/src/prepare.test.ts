import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { PREPARE_EDIT_SCHEMA_VERSION, PrepareEditResult } from "@invariance/gps-schemas";
import { parseFile } from "./parser.js";
import { buildIndex, writeIndex } from "./index_store.js";
import { open, prepareEdit } from "./query.js";
import { appendAreaNote, appendFileNote } from "./notes.js";

const roots: string[] = [];

async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-prepare-"));
  roots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, ".gps"), { recursive: true });

  await writeFile(
    path.join(root, "src/refunds.ts"),
    [
      "export function approveRefund(amount: number) { return amount; }",
      "export function createRefund(amount: number) { return approveRefund(amount); }",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "src/api.ts"),
    [
      'import { createRefund } from "./refunds.js";',
      "export function refundEndpoint(amount: number) { return createRefund(amount); }",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, ".gps/invariants.yml"),
    [
      "- name: High-value refunds require approval",
      "  applies_to: [createRefund]",
      "  rule: Refunds over 1000 require finance_approval_id.",
      "  evidence: [docs/refund-policy.md]",
      "  severity: block",
    ].join("\n"),
  );

  const parsed = await Promise.all([
    parseFile(path.join(root, "src/refunds.ts")),
    parseFile(path.join(root, "src/api.ts")),
  ]);
  const index = await buildIndex(root, parsed);
  await writeIndex(root, index);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("prepareEdit result schema", () => {
  it("emits the versioned shape and validates against the zod schema", async () => {
    const root = await fixtureRepo();
    const ctx = await open(root);
    const result = await prepareEdit({ symbol: "createRefund", intent: "cap at 5000" }, ctx);

    expect(result.schema_version).toBe(PREPARE_EDIT_SCHEMA_VERSION);
    expect(() => PrepareEditResult.parse(result)).not.toThrow();

    expect(result.invariants_to_respect.map((i) => i.name)).toEqual([
      "High-value refunds require approval",
    ]);
    expect(result.risk).toBe("high");
    expect(result.markdown).toContain("createRefund");
    expect(result.markdown).toContain("cap at 5000");
  });

  it("emits the canonical section headings in stable order", async () => {
    const root = await fixtureRepo();
    const ctx = await open(root);
    const result = await prepareEdit({ symbol: "createRefund", intent: "cap at 5000" }, ctx);

    const headings = result.markdown
      .split("\n")
      .filter((line) => /^#{1,2} /.test(line))
      .map((line) => line.trim());

    // Top heading is always present and includes the symbol name.
    expect(headings[0]).toBe("# prepare_edit: createRefund");

    // Required section ordering when invariants and callers exist.
    // "## Recent changes" is omitted: it only appears when git provenance is
    // available, which isn't true in a `mkdtemp` repo without `git init`.
    const required = [
      "## Invariants that apply",
      "## Called by",
    ];
    let cursor = 0;
    for (const want of required) {
      const idx = headings.indexOf(want, cursor);
      expect(idx, `missing or out-of-order: ${want}`).toBeGreaterThanOrEqual(0);
      cursor = idx + 1;
    }
  });
});

describe("prepareEdit surfaces approved path/area directives", () => {
  it("renders area + file notes for the symbol's path in a dedicated section", async () => {
    const root = await fixtureRepo();
    // refundEndpoint lives in src/api.ts → ancestor dir "src".
    await appendAreaNote(root, {
      id: "dir1",
      target: "src",
      lesson: "in src, don't build error strings inline — use the errors module",
    });
    await appendFileNote(root, {
      id: "file1",
      target: "src/api.ts",
      lesson: "validate the amount in this file before calling createRefund",
    });

    const ctx = await open(root);
    const result = await prepareEdit({ symbol: "refundEndpoint", intent: "return a typed error" }, ctx);

    expect(result.markdown).toContain("## Directives for this path");
    expect(result.markdown).toContain("don't build error strings inline");
    expect(result.markdown).toContain("[area: `src`]");
    expect(result.markdown).toContain("validate the amount in this file");

    // The structured payload carries the area/file notes too.
    const scopes = result.notes.map((n) => n.scope ?? "symbol");
    expect(scopes).toContain("area");
    expect(scopes).toContain("file");
  });

  it("omits the directives section when no path/area notes exist", async () => {
    const root = await fixtureRepo();
    const ctx = await open(root);
    const result = await prepareEdit({ symbol: "createRefund", intent: "cap at 5000" }, ctx);
    expect(result.markdown).not.toContain("## Directives for this path");
  });
});
