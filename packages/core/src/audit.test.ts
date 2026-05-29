import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { auditSession } from "./audit.js";
import { writeIndex, clearIndexCache, type GpsIndex } from "./index_store.js";
import { recordPrepared } from "./observer.js";
import { appendNote } from "./notes.js";

const roots: string[] = [];

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

// Commit with identity/signing supplied inline to avoid extra `git config`
// subprocess spawns — these tests are git-bound and run under parallel load.
function commit(root: string, message: string): void {
  git(root, [
    "-c",
    "user.email=t@t.dev",
    "-c",
    "user.name=t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  ]);
}

async function tempGitRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-audit-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  return root;
}

function indexWith(root: string, symbols: GpsIndex["symbols"]): GpsIndex {
  return {
    version: 1,
    built_at: new Date().toISOString(),
    root,
    files: ["src/cart.ts"],
    symbols,
    edges: [],
  };
}

const cartV1 = [
  "export function applyDiscount(subtotal: number, percent: number): number {",
  "  return Math.round(subtotal * (1 - percent / 100));",
  "}",
  "",
].join("\n");

const cartV2 = [
  "export function applyDiscount(subtotal: number, percent: number): number {",
  "  const safe = Math.max(0, Math.min(100, percent));",
  "  return Math.round(subtotal * (1 - safe / 100));",
  "}",
  "",
].join("\n");

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
  clearIndexCache();
});

describe("auditSession CLI-only fallbacks (no session attribution log)", () => {
  it("detects a working-tree edit via git diff instead of claiming no edits", async () => {
    const root = await tempGitRepo();
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/cart.ts"), cartV1);
    git(root, ["add", "-A"]);
    commit(root, "init");
    await writeFile(path.join(root, "src/cart.ts"), cartV2); // edit, uncommitted
    await writeIndex(
      root,
      indexWith(root, [
        {
          id: "src/cart.ts#applyDiscount:1",
          name: "applyDiscount",
          qualified_name: "applyDiscount",
          file: "src/cart.ts",
          line: 1,
          end_line: 4,
          kind: "function",
        },
      ]),
    );

    const report = await auditSession(root);
    const prepare = report.checks.find((c) => c.id === "prepare-before-edit");
    // The edit is detected, so this is no longer a vacuous pass.
    expect(prepare?.detail).not.toContain("no edits attributed this session");
    expect(prepare?.detail).toContain("edit");
  }, 20000);

  it("credits prepare (from observer) and durable memory (from notes) for an edited symbol", async () => {
    const root = await tempGitRepo();
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/cart.ts"), cartV1);
    git(root, ["add", "-A"]);
    commit(root, "init");
    await writeFile(path.join(root, "src/cart.ts"), cartV2);
    await writeIndex(
      root,
      indexWith(root, [
        {
          id: "src/cart.ts#applyDiscount:1",
          name: "applyDiscount",
          qualified_name: "applyDiscount",
          file: "src/cart.ts",
          line: 1,
          end_line: 4,
          kind: "function",
        },
      ]),
    );
    await recordPrepared(root, "applyDiscount");
    await appendNote(root, { symbol: "applyDiscount", lesson: "clamp percent to 0-100 before applying" });

    const report = await auditSession(root);
    const prepare = report.checks.find((c) => c.id === "prepare-before-edit");
    const lesson = report.checks.find((c) => c.id === "durable-lesson");
    expect(prepare?.pass).toBe(true);
    expect(prepare?.detail).toMatch(/prepare\(s\) covered/);
    expect(lesson?.pass).toBe(true);
    expect(lesson?.detail).toContain("durable record");
  }, 20000);

  it("still reports no edits when the tree is clean", async () => {
    const root = await tempGitRepo();
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/cart.ts"), cartV1);
    git(root, ["add", "-A"]);
    commit(root, "init");
    await writeIndex(
      root,
      indexWith(root, [
        {
          id: "src/cart.ts#applyDiscount:1",
          name: "applyDiscount",
          qualified_name: "applyDiscount",
          file: "src/cart.ts",
          line: 1,
          end_line: 4,
          kind: "function",
        },
      ]),
    );

    const report = await auditSession(root);
    const prepare = report.checks.find((c) => c.id === "prepare-before-edit");
    const lesson = report.checks.find((c) => c.id === "durable-lesson");
    expect(prepare?.detail).toContain("no edits attributed this session");
    expect(lesson?.detail).toContain("no edits this session");
  }, 20000);
});
