import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  upsertManagedBlock,
  removeManagedBlock,
  PREFS_OPEN,
  PREFS_CLOSE,
} from "./claude_md.js";

const roots: string[] = [];
async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-block-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
});

const claude = (root: string) => path.join(root, "CLAUDE.md");

describe("managed block upsert/remove", () => {
  it("inserts a block and preserves surrounding bytes", async () => {
    const root = await tempRepo();
    await writeFile(claude(root), "# Repo\n\nfreeform notes\n");
    await upsertManagedBlock(root, PREFS_OPEN, PREFS_CLOSE, "- rule one");
    const out = await readFile(claude(root), "utf8");
    expect(out).toContain("# Repo");
    expect(out).toContain("freeform notes");
    expect(out).toContain(`${PREFS_OPEN}\n- rule one\n${PREFS_CLOSE}`);
  });

  it("is idempotent — re-writing identical body does not change the file", async () => {
    const root = await tempRepo();
    await upsertManagedBlock(root, PREFS_OPEN, PREFS_CLOSE, "- a\n- b");
    const first = await readFile(claude(root), "utf8");
    const res = await upsertManagedBlock(root, PREFS_OPEN, PREFS_CLOSE, "- a\n- b");
    expect(res.changed).toBe(false);
    expect(await readFile(claude(root), "utf8")).toBe(first);
  });

  it("replaces an existing block in place", async () => {
    const root = await tempRepo();
    await upsertManagedBlock(root, PREFS_OPEN, PREFS_CLOSE, "- old");
    await upsertManagedBlock(root, PREFS_OPEN, PREFS_CLOSE, "- new");
    const out = await readFile(claude(root), "utf8");
    expect(out).toContain("- new");
    expect(out).not.toContain("- old");
    expect(out.match(new RegExp(PREFS_OPEN, "g")) ?? []).toHaveLength(1);
  });

  it("removes the block but keeps surrounding content", async () => {
    const root = await tempRepo();
    await writeFile(claude(root), "# Repo\n");
    await upsertManagedBlock(root, PREFS_OPEN, PREFS_CLOSE, "- rule");
    await removeManagedBlock(root, PREFS_OPEN, PREFS_CLOSE);
    const out = await readFile(claude(root), "utf8");
    expect(out).toContain("# Repo");
    expect(out).not.toContain(PREFS_OPEN);
  });
});
