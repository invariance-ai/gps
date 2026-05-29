import { describe, expect, it, vi, afterEach } from "vitest";
import { Command } from "commander";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerWizard } from "./wizard.js";

const roots: string[] = [];

async function present(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function runSetup(root: string, extra: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerWizard(program);
  await program.parseAsync(["node", "gps", "setup", "--yes", "--root", root, ...extra]);
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
});

describe("gps setup --no-agent (CLI-only)", () => {
  it("initializes .gps/ but writes no agent integration files", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = await mkdtemp(path.join(tmpdir(), "gps-noagent-"));
    roots.push(root);

    await runSetup(root, ["--no-agent"]);

    expect(await present(path.join(root, ".gps/config.yml"))).toBe(true);
    for (const f of [".claude", "CLAUDE.md", ".mcp.json", "AGENTS.md", ".cursor"]) {
      expect(await present(path.join(root, f))).toBe(false);
    }
  });

  it("default (no --no-agent) still auto-wires an agent in a fresh repo", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = await mkdtemp(path.join(tmpdir(), "gps-default-"));
    roots.push(root);

    await runSetup(root, []);

    // Fresh repo with no agent dirs: auto-detect defaults to Claude Code.
    expect(await present(path.join(root, ".claude"))).toBe(true);
  });
});
