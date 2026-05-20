import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordObservation, readObservations, suggest } from "./observer.js";

const roots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-observer-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("observer", () => {
  it("records only symbol query metadata and suggests uncovered hot symbols", async () => {
    const root = await tempRepo();
    await recordObservation(root, "prepare_edit", "createRefund");
    await recordObservation(root, "get_context", "createRefund");
    await recordObservation(root, "tests_for", "createRefund");

    const store = await readObservations(root);
    expect(store.symbols.createRefund?.count).toBe(3);
    expect(store.symbols.createRefund?.tools).toEqual({
      prepare_edit: 1,
      get_context: 1,
      tests_for: 1,
    });

    const suggestions = await suggest(root, { min_count: 3 });
    expect(suggestions).toEqual([
      expect.objectContaining({ symbol: "createRefund", count: 3, reason: "no_note" }),
    ]);
  });

  it("does not suggest symbols already covered by invariants", async () => {
    const root = await tempRepo();
    await mkdir(path.join(root, ".gps"), { recursive: true });
    await writeFile(
      path.join(root, ".gps/invariants.yml"),
      [
        "- name: Refund approval",
        "  applies_to: [createRefund]",
        "  rule: Refunds over 1000 require approval.",
      ].join("\n"),
    );
    await recordObservation(root, "prepare_edit", "createRefund");
    await recordObservation(root, "get_context", "createRefund");
    await recordObservation(root, "tests_for", "createRefund");

    await expect(suggest(root, { min_count: 3 })).resolves.toEqual([]);
  });
});
