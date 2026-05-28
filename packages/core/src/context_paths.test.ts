import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeIndex, type GpsIndex } from "./index_store.js";
import { open, getContext } from "./query.js";
import { appendNote, appendAreaNote } from "./notes.js";

const roots: string[] = [];

async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-ctxpath-"));
  roots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, ".gps"), { recursive: true });
  await writeFile(
    path.join(root, "src/api.ts"),
    "export function refundEndpoint(amount: number) { return amount; }",
  );
  const index: GpsIndex = {
    version: 2,
    built_at: new Date().toISOString(),
    root,
    files: ["src/api.ts"],
    symbols: [
      {
        id: "src/api.ts#refundEndpoint",
        name: "refundEndpoint",
        qualified_name: "refundEndpoint",
        kind: "function",
        file: "src/api.ts",
        line: 1,
        end_line: 1,
      },
    ],
    edges: [],
  };
  await writeIndex(root, index);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const STRANDS = ["structural", "tests", "provenance", "invariants"] as const;

describe("getContext path/area note retrieval", () => {
  it("surfaces an area directive even when the symbol has its own note cap full", async () => {
    const root = await fixtureRepo();
    // Fill the symbol's own notes past the FULL cap (5).
    for (let i = 0; i < 6; i++) {
      await appendNote(root, { symbol: "refundEndpoint", lesson: `symbol note ${i}` });
    }
    await appendAreaNote(root, { id: "a1", target: "src", lesson: "area directive must survive" });

    const ctx = await open(root);
    const c = await getContext(
      { symbol: "refundEndpoint", depth: 2, strands: [...STRANDS], mode: "full", budget: 0 },
      ctx,
    );
    const lessons = c.notes.map((n) => n.lesson);
    expect(lessons).toContain("area directive must survive");
    expect(c.notes.some((n) => (n.scope ?? "symbol") === "area")).toBe(true);
  });

  it("drops an expired area note", async () => {
    const root = await fixtureRepo();
    await appendAreaNote(root, { id: "a2", target: "src", lesson: "expired directive" });
    // Backdate expiry into the past directly on the area file.
    const areaFile = path.join(root, ".gps/notes/area/src.yml");
    const { readFile } = await import("node:fs/promises");
    const { parse, stringify } = await import("yaml");
    const data = parse(await readFile(areaFile, "utf8")) as Array<Record<string, unknown>>;
    data[0]!.expires_at = "2000-01-01T00:00:00.000Z";
    await writeFile(areaFile, stringify(data));

    const ctx = await open(root);
    const c = await getContext(
      { symbol: "refundEndpoint", depth: 2, strands: [...STRANDS], mode: "full", budget: 0 },
      ctx,
    );
    expect(c.notes.map((n) => n.lesson)).not.toContain("expired directive");
  });
});
