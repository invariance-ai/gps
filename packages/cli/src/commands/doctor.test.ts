import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { addToInbox, appendAreaNote, addPreference } from "@invariance/gps-core";
import { runChecks, type Check } from "./doctor.js";

const roots: string[] = [];
async function seededRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gps-doctor-"));
  roots.push(root);
  await mkdir(path.join(root, ".gps"), { recursive: true });
  // One pending directive that touches a risk topic ("payment").
  await addToInbox(root, {
    kind: "directive",
    text: "in billing/, never log raw payment card numbers",
    area: "billing",
  });
  // One area note, one preference, one invariant → active-memory counts.
  await appendAreaNote(root, { id: "a1", target: "src", lesson: "use the errors module here" });
  await addPreference(root, { text: "keep PRs under 300 lines", source: "wizard" });
  await writeFile(
    path.join(root, ".gps/invariants.yml"),
    ["- name: Sample", "  applies_to: [foo]", "  rule: do the thing", "  severity: warn"].join("\n"),
  );
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

function byName(checks: Check[], name: string): Check | undefined {
  return checks.find((c) => c.name === name);
}

describe("gps doctor informational checks", () => {
  it("reports inbox, active memory, and stale memory", async () => {
    const root = await seededRepo();
    const checks = await runChecks(root);

    const inbox = byName(checks, "inbox (pending review)");
    expect(inbox).toBeDefined();
    expect(inbox!.detail).toContain("1 pending");
    expect(inbox!.detail).toContain("1 touch risk topics");

    const memory = byName(checks, "active memory");
    expect(memory).toBeDefined();
    expect(memory!.detail).toContain("1 invariants");
    expect(memory!.detail).toContain("1 preferences");
    expect(memory!.detail).toMatch(/\d+ notes/);

    const stale = byName(checks, "stale memory");
    expect(stale).toBeDefined();
    expect(stale!.ok).toBe(true);
  });

  it("informational checks never fail the run on their own", async () => {
    const root = await seededRepo();
    const checks = await runChecks(root);
    for (const name of ["inbox (pending review)", "active memory", "stale memory"]) {
      expect(byName(checks, name)!.ok).toBe(true);
    }
  });
});
