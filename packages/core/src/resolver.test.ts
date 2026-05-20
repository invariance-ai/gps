import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseFile } from "./parser.js";
import { buildResolver } from "./resolver.js";

describe("resolver (cross-file imports)", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "gps-resolver-"));
    await mkdir(path.join(root, "src"), { recursive: true });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves named imports across files exactly", async () => {
    await writeFile(path.join(root, "src/api.ts"),
      `import { helper } from "./util";\nexport function api() { return helper(); }\n`);
    await writeFile(path.join(root, "src/util.ts"),
      `export function helper() { return 1; }\n`);

    const parsed = await Promise.all([
      parseFile(path.join(root, "src/api.ts")),
      parseFile(path.join(root, "src/util.ts")),
    ]);
    const resolver = await buildResolver(parsed, { root });
    const r = resolver.resolveCall(path.join(root, "src/api.ts"), "helper");
    expect(r.status).toBe("exact");
    expect(r.target?.file).toBe(path.join(root, "src/util.ts"));
    expect(r.target?.name).toBe("helper");
  });

  it("resolves aliased named imports", async () => {
    await writeFile(path.join(root, "src/a.ts"),
      `import { helper as h } from "./util";\nexport function a() { return h(); }\n`);

    const parsed = await Promise.all([
      parseFile(path.join(root, "src/a.ts")),
      parseFile(path.join(root, "src/util.ts")),
    ]);
    const resolver = await buildResolver(parsed, { root });
    const r = resolver.resolveCall(path.join(root, "src/a.ts"), "h");
    expect(r.status).toBe("exact");
    expect(r.target?.name).toBe("helper");
  });

  it("chases re-exports through a barrel file", async () => {
    await writeFile(path.join(root, "src/barrel.ts"),
      `export { helper } from "./util";\n`);
    await writeFile(path.join(root, "src/consumer.ts"),
      `import { helper } from "./barrel";\nexport function c() { return helper(); }\n`);

    const parsed = await Promise.all([
      parseFile(path.join(root, "src/barrel.ts")),
      parseFile(path.join(root, "src/consumer.ts")),
      parseFile(path.join(root, "src/util.ts")),
    ]);
    const resolver = await buildResolver(parsed, { root });
    const r = resolver.resolveCall(path.join(root, "src/consumer.ts"), "helper");
    expect(r.status).toBe("exact");
    expect(r.target?.file).toBe(path.join(root, "src/util.ts"));
  });

  it("reports unresolved when the module exists but the name doesn't", async () => {
    await writeFile(path.join(root, "src/bad.ts"),
      `import { nope } from "./util";\nexport function b() { return nope(); }\n`);
    const parsed = await Promise.all([
      parseFile(path.join(root, "src/bad.ts")),
      parseFile(path.join(root, "src/util.ts")),
    ]);
    const resolver = await buildResolver(parsed, { root });
    const r = resolver.resolveCall(path.join(root, "src/bad.ts"), "nope");
    expect(r.status).toBe("unresolved");
  });
});
