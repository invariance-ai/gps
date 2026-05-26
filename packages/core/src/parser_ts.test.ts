import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  parseFileTS,
  parseStats,
  _resetParseCache,
  loadParseCache,
  saveParseCache,
} from "./parser_ts.js";

describe("parser_ts content-hash cache", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "gps-parser-cache-"));
    await mkdir(dir, { recursive: true });
  });
  beforeEach(() => {
    _resetParseCache();
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("hits the cache on identical content", async () => {
    const a = path.join(dir, "a.ts");
    const body = `export function add(a: number, b: number) { return a + b; }\n`;
    await writeFile(a, body);
    const first = await parseFileTS(a);
    expect(parseStats.misses).toBe(1);
    expect(parseStats.hits).toBe(0);

    const second = await parseFileTS(a);
    expect(parseStats.hits).toBe(1);
    expect(second.symbols.map((s) => s.name)).toEqual(first.symbols.map((s) => s.name));
  });

  it("two identical-content files in different paths share a cache entry but report their own path", async () => {
    const a = path.join(dir, "dup-a.ts");
    const b = path.join(dir, "dup-b.ts");
    const body = `export class Widget { hello() { return 1; } }\n`;
    await writeFile(a, body);
    await writeFile(b, body);

    const ra = await parseFileTS(a);
    const rb = await parseFileTS(b);
    expect(parseStats.misses).toBe(1);
    expect(parseStats.hits).toBe(1);
    expect(ra.path).toBe(a);
    expect(rb.path).toBe(b);
    expect(ra.symbols.every((s) => s.file === a)).toBe(true);
    expect(rb.symbols.every((s) => s.file === b)).toBe(true);
  });

  it("different content does not collide", async () => {
    const a = path.join(dir, "diff-a.ts");
    const b = path.join(dir, "diff-b.ts");
    await writeFile(a, `export function alpha() { return 1; }\n`);
    await writeFile(b, `export function beta() { return 2; }\n`);
    const ra = await parseFileTS(a);
    const rb = await parseFileTS(b);
    expect(parseStats.misses).toBe(2);
    expect(parseStats.hits).toBe(0);
    expect(ra.symbols.map((s) => s.name)).toContain("alpha");
    expect(rb.symbols.map((s) => s.name)).toContain("beta");
  });

  it("persists across processes via load/save", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gps-parser-persist-"));
    try {
      const f = path.join(root, "x.ts");
      await writeFile(f, `export const k = 42;\n`);

      // First "process": parse + save.
      await loadParseCache(root);
      await parseFileTS(f);
      expect(parseStats.misses).toBe(1);
      await saveParseCache(root);

      const written = await readFile(
        path.join(root, ".gps", "cache", "parse-cache.json"),
        "utf8",
      );
      expect(written.length).toBeGreaterThan(10);

      // Second "process": reset in-mem, reload from disk, parse should hit.
      _resetParseCache();
      await loadParseCache(root);
      await parseFileTS(f);
      expect(parseStats.hits).toBe(1);
      expect(parseStats.misses).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("parser_ts call-site extraction", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "gps-parser-calls-"));
  });
  beforeEach(() => _resetParseCache());
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("records `this.#private()` calls (regression: private methods showed 0 callers)", async () => {
    const f = path.join(dir, "ky.ts");
    await writeFile(
      f,
      `class Ky {
  #calculateDelay(): number { return 1; }
  foo() { return this.#calculateDelay(); }
  bar() { return this.#calculateDelay() + this.publicM(); }
  publicM() { return 2; }
}
`,
    );
    const pf = await parseFileTS(f);
    const callees = pf.call_sites.map((c) => c.callee_name);
    // private method is reachable from two sites, keyed by its qualified name
    expect(callees.filter((c) => c === "Ky.#calculateDelay")).toHaveLength(2);
    // the public `this.method()` path still works
    expect(callees).toContain("Ky.publicM");
  });
});
