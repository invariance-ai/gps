import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { ContextResult, PrepareEditResult } from "@invariance/gps-schemas";
import { parseFile } from "./parser.js";
import { buildIndex, writeIndex } from "./index_store.js";
import { open, getContext, prepareEdit, resolveSymbol, callersOf } from "./query.js";
import { formatContextMarkdown, formatContextPretty } from "./format.js";
import type { ContextResult as ContextResultType } from "@invariance/gps-schemas";

const roots: string[] = [];

/**
 * Fixture mirroring the Fix-2 symptom: a thin exported `retry` (no callers) in a
 * barrel file shadows a real `retry` that DOES have callers. The barrel file is
 * parsed first so it sorts first in the by-name lookup and becomes the resolved
 * (weak) symbol. `connected` is a separate well-wired symbol for the negative
 * case.
 */
async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-resolution-"));
  roots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, ".gps"), { recursive: true });

  // Disconnected re-export — parsed first → resolves as the weak `retry`.
  await writeFile(
    path.join(root, "src/index.ts"),
    "export function retry(x: number) { return x; }\n",
  );
  // Real impl with a caller, same name `retry`.
  await writeFile(
    path.join(root, "src/util.ts"),
    [
      "export function retry(fn: () => number) { return fn(); }",
      "export function withRetry(fn: () => number) { return retry(fn); }",
      "export function connected(n: number) { return n + 1; }",
      "export function callsConnected(n: number) { return connected(n); }",
    ].join("\n"),
  );

  const parsed = await Promise.all([
    parseFile(path.join(root, "src/index.ts")),
    parseFile(path.join(root, "src/util.ts")),
  ]);
  const index = await buildIndex(root, parsed);
  await writeIndex(root, index);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("resolution signals: zero-caller note + did-you-mean", () => {
  it("getContext flags a zero-caller resolution and points at a connected sibling", async () => {
    const root = await fixtureRepo();
    const ctx = await open(root);

    // Sanity: the resolved `retry` is the disconnected one.
    const resolved = resolveSymbol("retry", ctx)!;
    expect(resolved.file).toBe("src/index.ts");
    expect(callersOf(resolved, ctx).length).toBe(0);

    const c = await getContext(
      { symbol: "retry", depth: 1, strands: ["structural"], budget: 0 },
      ctx,
    );

    expect(() => ContextResult.parse(c)).not.toThrow();
    expect(c.resolution_warnings).toBeDefined();
    expect(c.resolution_warnings!.join("\n").toLowerCase()).toContain("no callers found");
    // Wording must be distinct from the "no tests" handling.
    expect(c.resolution_warnings!.join("\n").toLowerCase()).not.toContain("test");

    expect(c.did_you_mean).toBeDefined();
    expect(c.did_you_mean!.length).toBeGreaterThan(0);
    expect(c.did_you_mean!.some((d) => d.symbol === "retry" && /caller/.test(d.reason))).toBe(true);
  });

  it("prepareEdit surfaces the note + a 'You might mean' section in markdown and payload", async () => {
    const root = await fixtureRepo();
    const ctx = await open(root);
    const result = await prepareEdit({ symbol: "retry", intent: "add backoff" }, ctx);

    expect(() => PrepareEditResult.parse(result)).not.toThrow();
    expect(result.resolution_warnings).toBeDefined();
    expect(result.resolution_warnings!.join("\n").toLowerCase()).toContain("no callers found");
    expect(result.did_you_mean).toBeDefined();
    expect(result.did_you_mean!.length).toBeGreaterThan(0);

    expect(result.markdown).toContain("No callers found");
    expect(result.markdown).toContain("## You might mean");

    // Prior fields are untouched.
    expect(result.schema_version).toBeDefined();
    expect(Array.isArray(result.tests_to_run)).toBe(true);
    expect(Array.isArray(result.invariants_to_respect)).toBe(true);
  });

  it("is silent for a confident, well-connected symbol (no warning, no did-you-mean)", async () => {
    const root = await fixtureRepo();
    const ctx = await open(root);

    const c = await getContext(
      { symbol: "connected", depth: 1, strands: ["structural"], budget: 0 },
      ctx,
    );
    expect(c.callers.length).toBeGreaterThan(0);
    expect(c.resolution_warnings).toBeUndefined();
    expect(c.did_you_mean).toBeUndefined();

    const result = await prepareEdit({ symbol: "connected", intent: "tweak" }, ctx);
    expect(result.resolution_warnings).toBeUndefined();
    expect(result.did_you_mean).toBeUndefined();
    expect(result.markdown).not.toContain("No callers found");
    expect(result.markdown).not.toContain("## You might mean");
  });

  it("surfaces a candidate alternate when the top intent pick has zero callers", async () => {
    const root = await fixtureRepo();
    const ctx = await open(root);

    // Simulate intent inference where the top pick (disconnected retry) loses to
    // a lower-ranked, connected candidate.
    const result = await prepareEdit(
      {
        symbol: "retry",
        intent: "add backoff",
        candidates: [
          { symbol: "retry", score: 95, via: "exact" },
          { symbol: "withRetry", score: 80, via: "prefix" },
        ],
      },
      ctx,
    );

    expect(result.did_you_mean).toBeDefined();
    // withRetry has a caller? No — withRetry is itself a caller of retry, so it
    // may have zero callers. The same-name `retry` sibling is the reliable hint.
    expect(result.did_you_mean!.some((d) => /caller/.test(d.reason))).toBe(true);
  });
});

describe("format: resolution signals render in markdown and pretty output", () => {
  const base: ContextResultType = {
    symbol: { name: "retry", file: "src/index.ts", line: 1, kind: "function" },
    callers: [],
    callees: [],
    tests: [],
    provenance: [],
    invariants: [],
    notes: [],
    decisions: [],
    preferences: [],
    risk: "low",
    todos: [],
  };

  it("renders the warning + did-you-mean when present", () => {
    const r: ContextResultType = {
      ...base,
      resolution_warnings: ["No callers found — this symbol may be unexported."],
      did_you_mean: [{ symbol: "retry", reason: "same name, has 1 caller — src/util.ts:1" }],
    };
    const md = formatContextMarkdown(r);
    expect(md).toContain("No callers found");
    expect(md).toContain("## You might mean");
    expect(md).toContain("src/util.ts:1");

    const pretty = formatContextPretty(r);
    expect(pretty).toContain("No callers found");
    expect(pretty).toContain("You might mean:");
  });

  it("renders neither when absent", () => {
    const md = formatContextMarkdown(base);
    expect(md).not.toContain("No callers found");
    expect(md).not.toContain("## You might mean");
    const pretty = formatContextPretty(base);
    expect(pretty).not.toContain("You might mean:");
  });
});
