import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { buildResolvePacket, inferResolveKind } from "./resolve.js";
import { formatResolveMarkdown } from "./format.js";
import { appendInvariants } from "./invariants.js";
import { appendNote } from "./notes.js";
import { writeIndex, clearIndexCache, type GpsIndex } from "./index_store.js";
import type { SymbolRef } from "@invariance/gps-schemas";

const roots: string[] = [];

function sym(name: string, file: string, line = 1, end_line = 10): SymbolRef {
  return { name, qualified_name: name, file, line, end_line, kind: "function" };
}

/**
 * Graph: caller2 -> caller1 -> helper -> leaf.
 * So the reverse closure of `helper` is {caller1, caller2}, and its forward
 * dependency is {leaf}.
 */
async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-resolve-"));
  roots.push(root);
  const symbols = [
    sym("helper", "src/util.ts"),
    sym("caller1", "src/a.ts"),
    sym("caller2", "src/b.ts"),
    sym("leaf", "src/leaf.ts"),
  ];
  const index: GpsIndex = {
    version: 2,
    built_at: "2024-01-01T00:00:00.000Z",
    root,
    files: ["src/util.ts", "src/a.ts", "src/b.ts", "src/leaf.ts", "src/util.test.ts"],
    symbols,
    edges: [
      { from: "caller1", to: "helper", type: "calls" },
      { from: "caller2", to: "caller1", type: "calls" },
      { from: "helper", to: "leaf", type: "calls" },
    ],
  };
  await writeIndex(root, index);
  // A test file that mentions `helper` so the test scan finds it.
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/util.test.ts"), "import { helper } from './util';\ntest('helper', () => {});\n");
  return root;
}

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
  clearIndexCache();
});

describe("inferResolveKind", () => {
  it("classifies targets without touching the index", () => {
    expect(inferResolveKind("")).toBe("diff");
    expect(inferResolveKind("1234")).toBe("pr");
    expect(inferResolveKind("HEAD~2")).toBe("commit");
    expect(inferResolveKind("a1b2c3d")).toBe("commit");
    expect(inferResolveKind("main..feature")).toBe("commit");
    expect(inferResolveKind("src/util.ts")).toBe("file");
    expect(inferResolveKind("helper.ts")).toBe("file");
    expect(inferResolveKind("buildResolvePacket")).toBe("symbol");
  });
});

describe("buildResolvePacket — symbol target", () => {
  it("returns the reverse blast radius, forward dependencies, and tests", { timeout: 30_000 }, async () => {
    const root = await fixtureRepo();
    const r = await buildResolvePacket({ target: { kind: "symbol", value: "helper" }, includePr: false }, root);

    expect(r.seeds.map((s) => s.name)).toEqual(["helper"]);
    const affected = r.affected_symbols.map((s) => s.name).sort();
    expect(affected).toEqual(["caller1", "caller2"]);
    expect(r.blast_radius).toBe(2);
    expect(r.dependencies.map((s) => s.name)).toEqual(["leaf"]);
    expect(r.affected_tests.map((t) => t.file)).toContain("src/util.test.ts");
  });

  it("tiers invariants by how they reach the change", { timeout: 30_000 }, async () => {
    const root = await fixtureRepo();
    await appendInvariants(root, [
      { name: "helper-rule", applies_to: ["helper"], rule: "never mutate input", evidence: [], severity: "block" },
      { name: "caller-rule", applies_to: ["caller1"], rule: "must validate", evidence: [], severity: "warn" },
    ]);
    const r = await buildResolvePacket({ target: { kind: "symbol", value: "helper" }, includePr: false }, root);

    const byName = new Map(r.invariants.map((i) => [i.invariant.name, i.relation]));
    expect(byName.get("helper-rule")).toBe("direct");
    expect(byName.get("caller-rule")).toBe("transitive");
    // Blocking invariant sorts first.
    expect(r.invariants[0]!.invariant.name).toBe("helper-rule");
  });

  it("attaches symbol notes", { timeout: 30_000 }, async () => {
    const root = await fixtureRepo();
    await appendNote(root, { symbol: "helper", lesson: "helper is hot-path; avoid allocation", severity: "high" });
    const r = await buildResolvePacket({ target: { kind: "symbol", value: "helper" }, includePr: false }, root);
    expect(r.notes.some((n) => n.lesson.includes("hot-path"))).toBe(true);
  });

  it("throws a helpful error for an unknown symbol", { timeout: 30_000 }, async () => {
    const root = await fixtureRepo();
    await expect(
      buildResolvePacket({ target: { kind: "symbol", value: "doesNotExist" } }, root),
    ).rejects.toThrow(/symbol not found/);
  });
});

describe("buildResolvePacket — file target", () => {
  it("seeds every symbol in the file", { timeout: 30_000 }, async () => {
    const root = await fixtureRepo();
    const r = await buildResolvePacket({ target: { kind: "file", value: "src/util.ts" }, includePr: false }, root);
    expect(r.seeds.map((s) => s.name)).toEqual(["helper"]);
    expect(r.target.kind).toBe("file");
  });
});

describe("buildResolvePacket — no gh available", () => {
  it("omits PR context and never throws when gh has no PR", { timeout: 30_000 }, async () => {
    const root = await fixtureRepo();
    // includePr defaults true; the temp repo is not a git checkout with a PR, so
    // the best-effort gh lookup returns nothing and `pr` stays undefined (no throw).
    const r = await buildResolvePacket({ target: { kind: "symbol", value: "helper" } }, root);
    expect(r.pr).toBeUndefined();
  });
});

describe("formatResolveMarkdown budgeting", () => {
  it("drops low-priority sections under a tight budget and records them", { timeout: 30_000 }, async () => {
    const root = await fixtureRepo();
    await appendInvariants(root, [
      { name: "helper-rule", applies_to: ["helper"], rule: "never mutate input", evidence: [], severity: "block" },
    ]);
    const r = await buildResolvePacket({ target: { kind: "symbol", value: "helper" }, includePr: false }, root);

    const full = formatResolveMarkdown(r, 0);
    expect(full).toContain("Blocking invariants");
    expect(full).not.toContain("Truncated (budget)");

    const tiny = formatResolveMarkdown(r, 60);
    // The blocking invariant (top priority) survives; lower sections are cut.
    expect(tiny).toContain("Blocking invariants");
    expect(tiny).toContain("Truncated (budget)");
  });
});
