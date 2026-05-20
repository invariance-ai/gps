import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { utimes } from "node:fs/promises";
import { parseFile } from "./parser.js";
import { buildIndex, writeIndex, staleFiles } from "./index_store.js";
import { open, getContext, impactOf, resolveSymbol } from "./query.js";

const roots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-core-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("index graph", () => {
  it("assigns stable symbol ids and resolves same-file call edges without name-only collisions", async () => {
    const root = await tempRepo();
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src/a.ts"),
      [
        "export function helper() { return 1; }",
        "export function caller() { return helper(); }",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "src/b.ts"),
      "export function helper() { return 2; }\n",
    );

    const parsed = await Promise.all([
      parseFile(path.join(root, "src/a.ts")),
      parseFile(path.join(root, "src/b.ts")),
    ]);
    const index = await buildIndex(root, parsed);
    const caller = index.symbols.find((s) => s.name === "caller");
    const aHelper = index.symbols.find((s) => s.file === "src/a.ts" && s.name === "helper");
    const bHelper = index.symbols.find((s) => s.file === "src/b.ts" && s.name === "helper");

    // Stable IDs: `<file>#<qualified_name>@<10-char-hex>` — line-movement robust.
    expect(caller?.id).toMatch(/^src\/a\.ts#caller@[0-9a-f]{10}$/);
    expect(aHelper?.id).toMatch(/^src\/a\.ts#helper@[0-9a-f]{10}$/);
    expect(bHelper?.id).toMatch(/^src\/b\.ts#helper@[0-9a-f]{10}$/);
    expect(aHelper?.id).not.toBe(bHelper?.id);
    expect(index.edges).toContainEqual(
      expect.objectContaining({ from_id: caller?.id, to_id: aHelper?.id }),
    );
    expect(index.edges).not.toContainEqual(
      expect.objectContaining({ from_id: caller?.id, to_id: bHelper?.id }),
    );
  });

  it("returns scoped context, impact, tests, invariants, and notes", async () => {
    const root = await tempRepo();
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, ".gps/notes"), { recursive: true });
    await writeFile(
      path.join(root, "src/refunds.ts"),
      [
        "export function approveRefund() { return true; }",
        "export function createRefund() { return approveRefund(); }",
        "export function supportRefundWorkflow() { return createRefund(); }",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "src/refunds.test.ts"),
      "import { createRefund } from './refunds';\ntest('refund', () => createRefund());\n",
    );
    await mkdir(path.join(root, ".gps"), { recursive: true });
    await writeFile(
      path.join(root, ".gps/invariants.yml"),
      [
        "- name: High-value refunds require approval",
        "  applies_to: [createRefund]",
        "  rule: Refunds over 1000 require finance_approval_id.",
        "  severity: block",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, ".gps/notes/createRefund.yml"),
      [
        "- symbol: createRefund",
        "  lesson: Preserve approval ordering.",
        "  severity: high",
        "  promoted: false",
        "  recorded_at: '2026-05-11T00:00:00.000Z'",
        "  source: human",
      ].join("\n"),
    );

    const parsed = await Promise.all([
      parseFile(path.join(root, "src/refunds.ts")),
      parseFile(path.join(root, "src/refunds.test.ts")),
    ]);
    await writeIndex(root, await buildIndex(root, parsed));

    const ctx = await open(root);
    const sym = resolveSymbol("createRefund", ctx);
    expect(sym?.id).toMatch(/^src\/refunds\.ts#createRefund@[0-9a-f]{10}$/);

    const result = await getContext(
      { symbol: "createRefund", depth: 2, strands: ["structural", "tests", "invariants"] },
      ctx,
    );
    expect(result.callers.map((s) => s.name)).toEqual(["supportRefundWorkflow"]);
    expect(result.callees.map((s) => s.name)).toEqual(["approveRefund"]);
    expect(result.tests.map((t) => t.file)).toEqual(["src/refunds.test.ts"]);
    expect(result.invariants.map((i) => i.name)).toEqual(["High-value refunds require approval"]);
    expect(result.notes.map((n) => n.lesson)).toEqual(["Preserve approval ordering."]);
    expect(result.risk).toBe("high");

    const impact = await impactOf({ symbol: "approveRefund", hops: 2 }, ctx);
    expect(impact.affected_symbols.map((s) => s.name)).toEqual([
      "createRefund",
      "supportRefundWorkflow",
    ]);
  });
});

describe("staleFiles", () => {
  it("flags files whose mtime is newer than the index built_at and notes missing files", async () => {
    const root = await tempRepo();
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/a.ts"), "export const a = 1;\n");
    await writeFile(path.join(root, "src/b.ts"), "export const b = 1;\n");
    const parsed = await Promise.all([
      parseFile(path.join(root, "src/a.ts")),
      parseFile(path.join(root, "src/b.ts")),
    ]);
    const index = await buildIndex(root, parsed);
    await writeIndex(root, index);

    // Make a.ts newer than the index, delete b.ts.
    const future = new Date(Date.now() + 60_000);
    await utimes(path.join(root, "src/a.ts"), future, future);
    await rm(path.join(root, "src/b.ts"));

    const report = await staleFiles(root, index);
    expect(report.stale_files).toContain("src/a.ts");
    expect(report.missing_files).toContain("src/b.ts");
  });
});
