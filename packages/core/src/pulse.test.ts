import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { pulse } from "./pulse.js";

const execFile = promisify(_execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, { cwd });
}

async function setupRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gps-pulse-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "t@t"]);
  await git(root, ["config", "user.name", "t"]);
  await writeFile(path.join(root, "a.ts"), `export function foo() { return 1; }\n`);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "init"]);
  return root;
}

describe("pulse", () => {
  it("returns a low-risk report on a no-op diff", async () => {
    const root = await setupRepo();
    const r = await pulse(root);
    expect(r.findings).toEqual([]);
    expect(r.risk_band).toBe("low");
    expect(r.risk_score).toBe(0);
  });

  it("flags invariant hit when a touched file matches an invariant", async () => {
    const root = await setupRepo();
    await mkdir(path.join(root, ".gps"), { recursive: true });
    await writeFile(
      path.join(root, ".gps/invariants.yml"),
      `- name: no-changes-to-a\n  applies_to: ["a.ts"]\n  rule: do not touch a.ts\n  severity: block\n`,
    );
    await writeFile(path.join(root, "a.ts"), `export function foo() { return 2; }\n`);
    const r = await pulse(root);
    const inv = r.findings.find((f) => f.kind === "invariant_hit");
    expect(inv).toBeDefined();
    expect(r.risk_band === "block" || r.risk_band === "high").toBe(true);
  });
});
