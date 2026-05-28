import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import type { DocModel } from "@invariance/gps-schemas";
import { writeDocStore, loadManifest } from "./doc_store.js";

const roots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-doc-store-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
});

function prModel(n: number): DocModel {
  return {
    schema_version: 1,
    kind: "pr",
    title: `PR ${n}`,
    generated_at: new Date(2026, 0, n).toISOString(),
    pr: { number: n, title: `PR ${n}`, body: "" },
    files: [],
    sections: [],
    annotations_unanchored: [],
  };
}

describe("writeDocStore", () => {
  it("writes html + md + manifest, returns relative paths", async () => {
    const root = await tempRepo();
    const res = await writeDocStore(root, prModel(7), { out_dir: ".gps/docs" });
    expect(res.htmlPath).toBe(path.join(".gps/docs", "pr-7.html"));
    expect(res.mdPath).toBe(path.join(".gps/docs", "pr-7.md"));
    const html = await readFile(path.join(root, res.htmlPath), "utf8");
    expect(html).toContain("<!doctype html>");
    const manifest = await loadManifest(root, ".gps/docs");
    expect(manifest.docs.map((d) => d.id)).toEqual(["pr-7"]);
  });

  it("upserts the manifest (no dupes) and appends new docs", async () => {
    const root = await tempRepo();
    await writeDocStore(root, prModel(7), { out_dir: ".gps/docs" });
    await writeDocStore(root, prModel(7), { out_dir: ".gps/docs" }); // re-run same PR
    await writeDocStore(root, prModel(8), { out_dir: ".gps/docs" });
    const manifest = await loadManifest(root, ".gps/docs");
    expect(manifest.docs).toHaveLength(2);
    expect(new Set(manifest.docs.map((d) => d.id))).toEqual(new Set(["pr-7", "pr-8"]));
  });
});
