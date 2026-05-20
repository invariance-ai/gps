import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { writeIndex, clearIndexCache } from "./index_store.js";
import type { GpsIndex } from "./index_store.js";
import { validateKnowledge } from "./validate_knowledge.js";

async function setupRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gps-vk-"));
  return root;
}

async function writeFakeIndex(
  root: string,
  symbols: Array<{ id?: string; name: string; qualified_name?: string; file: string; line?: number; kind?: string }>,
): Promise<void> {
  const idx: GpsIndex = {
    version: 1,
    built_at: new Date().toISOString(),
    root,
    files: Array.from(new Set(symbols.map((s) => s.file))),
    symbols: symbols.map((s) => ({
      id: s.id,
      name: s.name,
      qualified_name: s.qualified_name,
      file: s.file,
      line: s.line ?? 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      kind: (s.kind ?? "function") as any,
    })),
    edges: [],
  };
  await writeIndex(root, idx);
  clearIndexCache();
}

async function writeNote(root: string, name: string, note: Record<string, unknown>): Promise<void> {
  const dir = path.join(root, ".gps/notes");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.yml`), stringifyYaml([note]));
}

async function writeDecision(root: string, name: string, decision: Record<string, unknown>): Promise<void> {
  const dir = path.join(root, ".gps/decisions");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.yml`), stringifyYaml([decision]));
}

describe("validateKnowledge", () => {
  it("flags missing_anchor when name is not in index AND id not in idSet", async () => {
    const root = await setupRoot();
    await writeFakeIndex(root, [
      { id: "a.ts#foo@aaa", name: "foo", file: "a.ts" },
    ]);
    await writeNote(root, "gone", {
      symbol: "gone",
      lesson: "this symbol vanished",
      recorded_at: new Date().toISOString(),
      anchor_id: "a.ts#gone@deadbeef",
    });
    const r = await validateKnowledge(root);
    const missing = r.issues.filter((i) => i.kind === "missing_anchor");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.entry.symbol).toBe("gone");
  });

  it("does NOT flag when anchor_id matches a symbol id in the index", async () => {
    const root = await setupRoot();
    await writeFakeIndex(root, [
      { id: "a.ts#foo@aaa", name: "fooRenamed", file: "a.ts" },
    ]);
    // legacy `symbol` ("foo") no longer matches by name, but anchor_id hits idSet.
    await writeNote(root, "foo", {
      symbol: "foo",
      lesson: "stable id survives renames",
      recorded_at: new Date().toISOString(),
      anchor_id: "a.ts#foo@aaa",
    });
    const r = await validateKnowledge(root);
    expect(r.issues.filter((i) => i.kind === "missing_anchor")).toHaveLength(0);
  });

  it("fires `expired` for past dates", async () => {
    const root = await setupRoot();
    await writeFakeIndex(root, [{ id: "a#foo@1", name: "foo", file: "a.ts" }]);
    await writeNote(root, "foo", {
      symbol: "foo",
      lesson: "stale",
      recorded_at: "2020-01-01T00:00:00.000Z",
      anchor_id: "a#foo@1",
      expires_at: "2021-01-01T00:00:00.000Z",
    });
    const r = await validateKnowledge(root);
    expect(r.issues.some((i) => i.kind === "expired")).toBe(true);
  });

  it("does NOT fire `expired` for future dates", async () => {
    const root = await setupRoot();
    await writeFakeIndex(root, [{ id: "a#foo@1", name: "foo", file: "a.ts" }]);
    await writeNote(root, "foo", {
      symbol: "foo",
      lesson: "fresh",
      recorded_at: new Date().toISOString(),
      anchor_id: "a#foo@1",
      expires_at: "2999-01-01T00:00:00.000Z",
    });
    const r = await validateKnowledge(root);
    expect(r.issues.some((i) => i.kind === "expired")).toBe(false);
  });

  it("emits `invalid_expires_at` for unparseable dates", async () => {
    const root = await setupRoot();
    await writeFakeIndex(root, [{ id: "a#foo@1", name: "foo", file: "a.ts" }]);
    await writeNote(root, "foo", {
      symbol: "foo",
      lesson: "garbage date",
      recorded_at: new Date().toISOString(),
      anchor_id: "a#foo@1",
      expires_at: "not-a-real-date",
    });
    const r = await validateKnowledge(root);
    expect(r.issues.some((i) => i.kind === "invalid_expires_at")).toBe(true);
    // and it should NOT also be flagged expired (we `continue` after invalid).
    expect(r.issues.some((i) => i.kind === "expired")).toBe(false);
  });

  it("fuzzy suggester does NOT suggest `create` for `createRefund` (short-substring false positive)", async () => {
    const root = await setupRoot();
    await writeFakeIndex(root, [
      { id: "a.ts#create@1", name: "create", file: "a.ts" },
    ]);
    await writeNote(root, "createRefund", {
      symbol: "createRefund",
      lesson: "missing",
      recorded_at: new Date().toISOString(),
    });
    const r = await validateKnowledge(root);
    const missing = r.issues.find((i) => i.kind === "missing_anchor");
    expect(missing).toBeDefined();
    expect(missing!.suggested_anchor).toBeUndefined();
  });

  it("fuzzy suggester DOES suggest a near-match (Levenshtein-similar)", async () => {
    const root = await setupRoot();
    await writeFakeIndex(root, [
      { id: "a.ts#createRefund@1", name: "createRefund", file: "a.ts" },
    ]);
    await writeNote(root, "createRefnd", {
      symbol: "createRefnd",
      lesson: "typo",
      recorded_at: new Date().toISOString(),
    });
    const r = await validateKnowledge(root);
    const missing = r.issues.find((i) => i.kind === "missing_anchor");
    expect(missing).toBeDefined();
    expect(missing!.suggested_anchor?.qualified_name).toBe("createRefund");
  });

  it("fires `no_anchor_id` for legacy line-anchored entries when index has symbols", async () => {
    const root = await setupRoot();
    await writeFakeIndex(root, [{ id: "a.ts#foo@1", name: "foo", file: "a.ts" }]);
    await writeNote(root, "foo", {
      symbol: "foo",
      lesson: "legacy entry, no anchor_id",
      recorded_at: new Date().toISOString(),
      // no anchor_id
    });
    const r = await validateKnowledge(root);
    expect(r.issues.some((i) => i.kind === "no_anchor_id")).toBe(true);
  });

  it("`--legacy-ok` suppresses no_anchor_id findings", async () => {
    const root = await setupRoot();
    await writeFakeIndex(root, [{ id: "a.ts#foo@1", name: "foo", file: "a.ts" }]);
    await writeNote(root, "foo", {
      symbol: "foo",
      lesson: "legacy entry",
      recorded_at: new Date().toISOString(),
    });
    const r = await validateKnowledge(root, { legacyOk: true });
    expect(r.issues.some((i) => i.kind === "no_anchor_id")).toBe(false);
  });

  it("applies stable-id + invalid_expires_at logic for decisions too", async () => {
    const root = await setupRoot();
    await writeFakeIndex(root, [{ id: "a#bar@1", name: "barRenamed", file: "a.ts" }]);
    await writeDecision(root, "bar", {
      symbol: "bar",
      decision: "use feature flag",
      recorded_at: new Date().toISOString(),
      anchor_id: "a#bar@1",
    });
    const r = await validateKnowledge(root);
    expect(r.issues.filter((i) => i.kind === "missing_anchor")).toHaveLength(0);
  });
});
