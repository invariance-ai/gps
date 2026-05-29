import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadNotes, writeIndex } from "@invariance/gps-core";
import { registerNext } from "./next.js";
import { registerReviewMemory } from "./review-memory.js";
import { registerSaveThis } from "./save-this.js";
import { registerDoctor, runChecks } from "./doctor.js";

const roots: string[] = [];

async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gps-adoption-"));
  roots.push(root);
  await mkdir(path.join(root, ".gps"), { recursive: true });
  await writeFile(path.join(root, ".gps/config.yml"), "capture: auto\npromote: safe\nauto_suggest: false\n");
  await writeFile(path.join(root, ".gps/invariants.yml"), "[]\n");
  await writeFile(path.join(root, "refunds.ts"), "export function createRefund() { return true; }\n");
  await writeFile(path.join(root, "refunds.test.ts"), "import { createRefund } from './refunds';\n");
  await writeIndex(root, {
    version: 2,
    root,
    built_at: new Date().toISOString(),
    files: ["refunds.ts", "refunds.test.ts"],
    symbols: [
      {
        id: "refunds.ts#createRefund:1",
        name: "createRefund",
        qualified_name: "createRefund",
        kind: "function",
        file: "refunds.ts",
        line: 1,
        tokens: "create refund",
      },
    ],
    edges: [],
  });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  vi.restoreAllMocks();
  process.exitCode = 0;
});

async function run(register: (program: Command) => void, args: string[], root: string): Promise<string> {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((m?: unknown) => void out.push(String(m ?? "")));
  const program = new Command();
  program.exitOverride();
  register(program);
  await program.parseAsync([...args, "--root", root], { from: "user" });
  return out.join("\n");
}

describe("adoption commands", () => {
  it("gps next gives a concrete first command", async () => {
    const root = await repo();
    const out = await run(registerNext, ["next"], root);
    expect(out).toContain("gps next");
    expect(out).toContain("gps prepare");
    expect(out).toContain("createRefund");
  });

  it("gps save-this previews and can persist memory", async () => {
    const root = await repo();
    const preview = await run(registerSaveThis, ["save-this", "use the shared errors module", "--symbol", "createRefund"], root);
    expect(preview).toContain("Save this as GPS memory?");
    expect(preview).toContain("gps remember");

    await run(registerSaveThis, ["save-this", "use the shared errors module", "--symbol", "createRefund", "--yes"], root);
    const notes = await loadNotes(root, "createRefund");
    expect(notes.some((note) => note.lesson === "use the shared errors module")).toBe(true);
  });

  it("review-memory can write a static HTML review", async () => {
    const root = await repo();
    const out = await run(registerReviewMemory, ["review-memory", "--html"], root);
    expect(out).toContain("memory review written");
    const html = await readFile(path.join(root, ".gps/review/memory.html"), "utf8");
    expect(html).toContain("GPS memory review");
  });

  it("doctor exposes value summary in JSON", async () => {
    const root = await repo();
    const checks = await runChecks(root);
    expect(checks.find((check) => check.name === "active memory")).toBeDefined();
    const out = await run(registerDoctor, ["doctor", "--json"], root);
    const parsed = JSON.parse(out);
    expect(parsed.value.symbols).toBe(1);
    expect(parsed.value.try_now).toContain("gps prepare");
  });
});
