import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { loadNotes } from "@invariance/gps-core";
import { registerRemember } from "./remember.js";

const roots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gps-remember-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  vi.restoreAllMocks();
  process.exitCode = 0;
});

async function runRemember(root: string, args: string[]): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((m?: unknown) => void out.push(String(m ?? "")));
  vi.spyOn(console, "error").mockImplementation((m?: unknown) => void err.push(String(m ?? "")));
  const program = new Command();
  program.exitOverride();
  registerRemember(program);
  await program.parseAsync(["remember", ...args, "--root", root], { from: "user" });
  return { out: out.join("\n"), err: err.join("\n") };
}

describe("gps remember", () => {
  it("records agent reminders as high-priority symbol memory", async () => {
    const root = await tempRepo();
    await runRemember(root, [
      "still need to update the payer denial fixture",
      "--reminder",
      "--symbol",
      "routeToPayer",
      "--json",
    ]);

    const notes = await loadNotes(root, "routeToPayer");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.lesson).toBe(
      "Reminder for next agent: still need to update the payer denial fixture",
    );
    expect(notes[0]!.severity).toBe("high");
    expect(notes[0]!.classifier?.signals).toContain("reminder:agent");
  });

  it("can target reminders to both the next agent and human", async () => {
    const root = await tempRepo();
    await runRemember(root, [
      "confirm rollback plan before merge",
      "--reminder",
      "--for",
      "both",
      "--symbol",
      "runMigration",
    ]);

    const notes = await loadNotes(root, "runMigration");
    expect(notes[0]!.lesson).toBe(
      "Reminder for next agent and human: confirm rollback plan before merge",
    );
    expect(notes[0]!.classifier?.signals).toContain("reminder:both");
  });
});
