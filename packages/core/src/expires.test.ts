/**
 * Tests that expired notes/decisions are absent from getContext results.
 * Uses a fixture with a minimal index + note files.
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { filterExpiredNotes } from "./notes.js";
import { filterExpiredDecisions } from "./decisions.js";

const roots: string[] = [];
async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-expires-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
});

function daysAgo(d: number): string {
  return new Date(Date.now() - d * 86_400_000).toISOString();
}
function daysFromNow(d: number): string {
  return new Date(Date.now() + d * 86_400_000).toISOString();
}

describe("filterExpiredNotes", () => {
  it("filters out notes with expires_at in the past", () => {
    const notes = [
      { symbol: "a", lesson: "expired", expires_at: daysAgo(1), recorded_at: daysAgo(10), severity: "medium", promoted: false, source: "agent", scope: "symbol" },
      { symbol: "a", lesson: "active", expires_at: daysFromNow(10), recorded_at: daysAgo(10), severity: "medium", promoted: false, source: "agent", scope: "symbol" },
      { symbol: "a", lesson: "no expiry", recorded_at: daysAgo(10), severity: "medium", promoted: false, source: "agent", scope: "symbol" },
    ] as Parameters<typeof filterExpiredNotes>[0];
    const result = filterExpiredNotes(notes);
    expect(result).toHaveLength(2);
    expect(result.map((n) => n.lesson)).toEqual(["active", "no expiry"]);
  });

  it("keeps notes with no expires_at", () => {
    const notes = [
      { symbol: "a", lesson: "no expiry", recorded_at: daysAgo(10), severity: "medium", promoted: false, source: "agent", scope: "symbol" },
    ] as Parameters<typeof filterExpiredNotes>[0];
    expect(filterExpiredNotes(notes)).toHaveLength(1);
  });

  it("treats malformed expires_at as not expired", () => {
    const notes = [
      { symbol: "a", lesson: "bad date", expires_at: "not-a-date", recorded_at: daysAgo(1), severity: "medium", promoted: false, source: "agent", scope: "symbol" },
    ] as Parameters<typeof filterExpiredNotes>[0];
    expect(filterExpiredNotes(notes)).toHaveLength(1);
  });
});

describe("filterExpiredDecisions", () => {
  it("filters out decisions with expires_at in the past", () => {
    const decisions = [
      { symbol: "a", decision: "expired", expires_at: daysAgo(1), recorded_at: daysAgo(10), source: "human" },
      { symbol: "a", decision: "active", expires_at: daysFromNow(10), recorded_at: daysAgo(10), source: "human" },
    ] as Parameters<typeof filterExpiredDecisions>[0];
    const result = filterExpiredDecisions(decisions);
    expect(result).toHaveLength(1);
    expect(result[0]!.decision).toBe("active");
  });
});

describe("notes written to .gps/notes — expires_at filters on load+write", () => {
  it("an expired note written to disk is filtered out by filterExpiredNotes", async () => {
    const root = await tempRepo();
    const notesDir = path.join(root, ".gps/notes");
    await mkdir(notesDir, { recursive: true });
    const notes = [
      {
        symbol: "myFn",
        lesson: "expired note",
        severity: "medium",
        promoted: false,
        recorded_at: daysAgo(10),
        source: "agent",
        expires_at: daysAgo(1), // expired yesterday
      },
      {
        symbol: "myFn",
        lesson: "active note",
        severity: "medium",
        promoted: false,
        recorded_at: daysAgo(10),
        source: "agent",
        expires_at: daysFromNow(10),
      },
    ];
    await writeFile(path.join(notesDir, "myFn.yml"), stringifyYaml(notes));

    // Simulate what getContext does: loadNotes → filterExpiredNotes
    const { loadNotes } = await import("./notes.js");
    const loaded = await loadNotes(root, "myFn");
    const active = filterExpiredNotes(loaded);

    expect(loaded).toHaveLength(2); // loadNotes itself doesn't filter
    expect(active).toHaveLength(1);
    expect(active[0]!.lesson).toBe("active note");
  });
});
