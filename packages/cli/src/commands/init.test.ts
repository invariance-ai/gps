import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInitCore } from "./init.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gps-init-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("runInitCore", () => {
  it("adds local gps artifacts to .gitignore for a fresh repo", async () => {
    const root = await tempRoot();

    const result = await runInitCore(root, { force: false });

    const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain(".gps/index/\n");
    expect(gitignore).toContain(".gps/observations.json\n");
    expect(result.writes).toContainEqual({ action: "wrote", relPath: ".gitignore" });
  });

  it("preserves existing .gitignore content and only appends missing gps entries", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, ".gitignore"), "node_modules\n.gps/index/\n");

    await runInitCore(root, { force: false });

    expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(
      "node_modules\n.gps/index/\n.gps/observations.json\n",
    );
  });
});
