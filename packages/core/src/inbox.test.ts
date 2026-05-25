import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addToInbox,
  loadInbox,
  approveInboxItem,
  rejectInboxItem,
  editInboxItem,
} from "./inbox.js";
import { loadPreferences } from "./preferences.js";

const roots: string[] = [];
async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-inbox-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
});

describe("addToInbox", () => {
  it("queues an item and stamps risk topics", async () => {
    const root = await tempRepo();
    const { item, deduped } = await addToInbox(root, {
      kind: "preference",
      text: "always confirm before issuing a payment refund",
    });
    expect(deduped).toBe(false);
    expect(item.status).toBe("pending");
    expect(item.risk_topics).toContain("payments");
    expect(await loadInbox(root)).toHaveLength(1);
  });

  it("dedupes a repeated capture", async () => {
    const root = await tempRepo();
    await addToInbox(root, { kind: "preference", text: "use pnpm not npm" });
    const second = await addToInbox(root, { kind: "preference", text: "use pnpm not npm" });
    expect(second.deduped).toBe(true);
    expect(await loadInbox(root)).toHaveLength(1);
  });
});

describe("approveInboxItem", () => {
  it("persists an approved preference into preferences.yml", async () => {
    const root = await tempRepo();
    const { item } = await addToInbox(root, { kind: "preference", text: "prefer terse PRs" });
    const res = await approveInboxItem(root, item.id);
    expect(res?.persisted).toBe("preference");
    const prefs = await loadPreferences(root);
    expect(prefs.map((p) => p.text)).toContain("prefer terse PRs");
    // status flipped + retained for audit
    const after = await loadInbox(root);
    expect(after.find((i) => i.id === item.id)?.status).toBe("approved");
  });

  it("persists an approved directive into an area note", async () => {
    const root = await tempRepo();
    const { item } = await addToInbox(root, {
      kind: "directive",
      text: "don't add comments here",
      polarity: "dont",
      area: "src/api",
    });
    const res = await approveInboxItem(root, item.id);
    expect(res?.persisted).toBe("area-note");
    expect(res?.item.area).toBe("src/api");
  });

  it("returns null for an unknown id and no-ops on already-approved", async () => {
    const root = await tempRepo();
    const { item } = await addToInbox(root, { kind: "preference", text: "x y z lesson" });
    await approveInboxItem(root, item.id);
    expect(await approveInboxItem(root, item.id)).toBeNull();
    expect(await approveInboxItem(root, "deadbeef")).toBeNull();
  });
});

describe("reject / edit", () => {
  it("rejects an item (kept in the file)", async () => {
    const root = await tempRepo();
    const { item } = await addToInbox(root, { kind: "preference", text: "reject me please" });
    const rejected = await rejectInboxItem(root, item.id);
    expect(rejected?.status).toBe("rejected");
    expect(await loadInbox(root)).toHaveLength(1);
  });

  it("edits text and recomputes risk topics, keeping id stable", async () => {
    const root = await tempRepo();
    const { item } = await addToInbox(root, { kind: "preference", text: "benign lesson" });
    expect(item.risk_topics).toEqual([]);
    const edited = await editInboxItem(root, item.id, "always require auth on this endpoint");
    expect(edited?.id).toBe(item.id);
    expect(edited?.risk_topics).toContain("auth");
  });

  it("resolves items by unambiguous id prefix", async () => {
    const root = await tempRepo();
    const { item } = await addToInbox(root, { kind: "preference", text: "prefix lookup test" });
    const rejected = await rejectInboxItem(root, item.id.slice(0, 6));
    expect(rejected?.id).toBe(item.id);
  });
});
