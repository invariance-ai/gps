import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { registerPromote } from "./promote.js";

const roots: string[] = [];
async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gps-promote-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  vi.restoreAllMocks();
  process.exitCode = 0;
});

/** Run `gps promote …` against a fresh program, capturing stdout. */
async function runPromote(root: string, args: string[]): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((m?: unknown) => void out.push(String(m ?? "")));
  vi.spyOn(console, "error").mockImplementation((m?: unknown) => void err.push(String(m ?? "")));
  const program = new Command();
  program.exitOverride();
  registerPromote(program);
  await program.parseAsync(["promote", ...args, "--root", root], { from: "user" });
  return { out: out.join("\n"), err: err.join("\n") };
}

describe("gps promote --auto[=policy]", () => {
  it("bare --auto uses the config default (never) on a fresh repo", async () => {
    const root = await tempRepo();
    const { out } = await runPromote(root, ["--auto", "--json"]);
    expect(JSON.parse(out)).toMatchObject({ policy: "never" });
  });

  it("--auto=safe overrides config (never) for this run", async () => {
    const root = await tempRepo();
    const { out } = await runPromote(root, ["--auto=safe", "--json"]);
    expect(JSON.parse(out)).toMatchObject({ policy: "safe", promoted: [], skipped_risk: [] });
  });

  it("--auto=all overrides config for this run", async () => {
    const root = await tempRepo();
    const { out } = await runPromote(root, ["--auto=all", "--dry-run", "--json"]);
    expect(JSON.parse(out)).toMatchObject({ policy: "all" });
  });

  it("rejects an invalid --auto value with a non-zero exit", async () => {
    const root = await tempRepo();
    const { err } = await runPromote(root, ["--auto=bogus"]);
    expect(err).toContain("invalid --auto value 'bogus'");
    expect(process.exitCode).toBe(1);
  });
});
