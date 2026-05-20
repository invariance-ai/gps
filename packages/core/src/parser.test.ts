import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseFile } from "./parser.js";

describe("parser (tree-sitter)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "gps-parser-"));
    await mkdir(dir, { recursive: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("extracts TS classes, methods, function decls, and arrow fns", async () => {
    const file = path.join(dir, "a.ts");
    await writeFile(file, `
export class Foo {
  bar() { return baz(); }
  async qux() { return this.bar(); }
}
function baz() { return 1; }
export const arrow = () => baz();
interface Iface { x: number }
type Alias = string;
`);
    const parsed = await parseFile(file);
    const names = parsed.symbols.map((s) => `${s.kind}:${s.qualified_name}`).sort();
    expect(names).toContain("class:Foo");
    expect(names).toContain("method:Foo.bar");
    expect(names).toContain("method:Foo.qux");
    expect(names).toContain("function:baz");
    expect(names).toContain("function:arrow");
    expect(names).toContain("type:Iface");
    expect(names).toContain("type:Alias");

    const calls = parsed.call_sites.map((c) => `${c.from}->${c.callee_name}`).sort();
    expect(calls).toContain("Foo.bar->baz");
    expect(calls).toContain("arrow->baz");
    // this.method() now resolves to ClassName.method via the classStack
    expect(calls).toContain("Foo.qux->Foo.bar");
  });

  it("extracts Python classes, methods, functions, and call sites", async () => {
    const file = path.join(dir, "a.py");
    await writeFile(file, `
class Foo:
    def bar(self):
        return baz()
    def qux(self):
        return self.bar()

def baz():
    return 1
`);
    const parsed = await parseFile(file);
    const names = parsed.symbols.map((s) => `${s.kind}:${s.qualified_name}`).sort();
    expect(names).toContain("class:Foo");
    expect(names).toContain("method:Foo.bar");
    expect(names).toContain("method:Foo.qux");
    expect(names).toContain("function:baz");

    const calls = parsed.call_sites.map((c) => `${c.from}->${c.callee_name}`).sort();
    expect(calls).toContain("Foo.bar->baz");
    // self.method() now resolves to ClassName.method via classStack
    expect(calls).toContain("Foo.qux->Foo.bar");
  });

  it("extracts tsx components and decorated TS classes", async () => {
    const file = path.join(dir, "comp.tsx");
    await writeFile(file, `
function Button({ label }: { label: string }) {
  return <button>{label}</button>;
}
export const Card = () => <div><Button label="x" /></div>;

function logged(_t: unknown, _k: string) { /* decorator */ }

@logged
class Service {
  @logged
  run() { return 1; }
}
`);
    const parsed = await parseFile(file);
    const names = parsed.symbols.map((s) => `${s.kind}:${s.qualified_name}`).sort();
    expect(names).toContain("function:Button");
    expect(names).toContain("function:Card");
    expect(names).toContain("class:Service");
    expect(names).toContain("method:Service.run");
  });

  it("extracts Python decorated methods and @property", async () => {
    const file = path.join(dir, "decorated.py");
    await writeFile(file, `
class Box:
    @property
    def width(self):
        return self._w

    @staticmethod
    def make():
        return Box()
`);
    const parsed = await parseFile(file);
    const names = parsed.symbols.map((s) => `${s.kind}:${s.qualified_name}`).sort();
    expect(names).toContain("class:Box");
    expect(names).toContain("method:Box.width");
    expect(names).toContain("method:Box.make");
  });

  it("falls back to regex for unsupported extensions (.go)", async () => {
    const file = path.join(dir, "a.go");
    await writeFile(file, `
package main
func Hello() string { return "hi" }
type T struct {}
`);
    const parsed = await parseFile(file);
    const names = parsed.symbols.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain("function:Hello");
    expect(names).toContain("type:T");
  });
});
