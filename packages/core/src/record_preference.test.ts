import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordPreference, loadInbox } from "./inbox.js";
import { loadPreferences } from "./preferences.js";
import { writePolicy } from "./scan.js";
import { GpsPolicy } from "@invariance/gps-schemas";

const roots: string[] = [];
async function tempRepo(capture: "auto" | "inbox"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-rp-"));
  roots.push(root);
  await writePolicy(root, GpsPolicy.parse({ capture }));
  return root;
}
afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
});

describe("recordPreference (Fix 4: honor the capture gate)", () => {
  it("routes an explicit preference to ACTIVE under capture=auto", async () => {
    const root = await tempRepo("auto");
    const result = await recordPreference(root, { text: "keep PRs under 300 lines" });

    expect(result.placement).toBe("active");
    expect(result.message).toBe("recorded to active memory");
    expect(result.preference).toBeDefined();
    expect(result.inbox).toBeUndefined();

    expect(await loadPreferences(root)).toHaveLength(1);
    expect(await loadInbox(root)).toHaveLength(0);
  });

  it("routes an explicit preference to the INBOX (pending) under capture=inbox", async () => {
    const root = await tempRepo("inbox");
    const result = await recordPreference(root, { text: "always run pnpm test before pushing" });

    expect(result.placement).toBe("inbox");
    expect(result.message).toContain("queued for review");
    expect(result.message).toContain("capture=inbox");
    expect(result.inbox).toBeDefined();
    expect(result.inbox!.item.status).toBe("pending");
    expect(result.preference).toBeUndefined();

    // Did NOT bypass the gate into active memory.
    expect(await loadPreferences(root)).toHaveLength(0);
    const inbox = await loadInbox(root);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.kind).toBe("preference");
    expect(inbox[0]!.status).toBe("pending");
  });

  it("reports dedupe distinctly for each placement", async () => {
    const active = await tempRepo("auto");
    await recordPreference(active, { text: "prefer terse explanations" });
    const a2 = await recordPreference(active, { text: "prefer terse explanations" });
    expect(a2.placement).toBe("active");
    expect(a2.deduped).toBe(true);
    expect(a2.message).toBe("already in active memory");

    const queued = await tempRepo("inbox");
    await recordPreference(queued, { text: "prefer terse explanations" });
    const q2 = await recordPreference(queued, { text: "prefer terse explanations" });
    expect(q2.placement).toBe("inbox");
    expect(q2.deduped).toBe(true);
    expect(q2.message).toContain("capture=inbox");
  });
});
