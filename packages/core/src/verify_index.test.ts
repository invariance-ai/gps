import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseFile } from "./parser.js";
import { buildIndex } from "./index_store.js";
import { verifyIndex } from "./verify_index.js";

describe("verifyIndex", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "gps-verify-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: false },
      include: ["src/**/*"],
    }));
    await writeFile(path.join(root, "src/util.ts"),
      `export function helper() { return 1; }\nexport function other() { return 2; }\n`);
    await writeFile(path.join(root, "src/api.ts"),
      `import { helper } from "./util";\nexport function api() { return helper(); }\n`);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports high precision and coverage when GPS matches the type checker", async () => {
    const parsed = await Promise.all([
      parseFile(path.join(root, "src/util.ts")),
      parseFile(path.join(root, "src/api.ts")),
    ]);
    const index = await buildIndex(root, parsed);
    const report = await verifyIndex(index, { root, sample: 10 });

    expect(report.language).toBe("typescript");
    expect(report.total_edges).toBeGreaterThan(0);
    expect(report.precision).toBeGreaterThanOrEqual(0.9);
    expect(report.coverage).toBe(1);
  });
});
