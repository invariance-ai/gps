import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addToInbox,
  loadInbox,
  annotateInboxDuplicates,
  buildInboxReview,
  approveInboxItem,
  rejectInboxItem,
  editInboxItem,
  mergeInboxDuplicates,
} from "./inbox.js";
import { loadPreferences, addPreference } from "./preferences.js";
import { recordDirective } from "./lessons.js";

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

describe("annotateInboxDuplicates", () => {
  it("tags a pending preference whose text already exists as an active preference (exact)", async () => {
    const root = await tempRepo();
    // active memory gains the preference via a separate path (e.g. `gps prefer`)
    await addPreference(root, { text: "always add retry logic to network calls" });

    // a pending inbox capture with equivalent text (different casing/whitespace)
    const { item: dupe } = await addToInbox(root, {
      kind: "preference",
      text: "  Always add retry logic to network calls  ",
    });

    const annotated = await annotateInboxDuplicates(root, await loadInbox(root));
    const dupeAnn = annotated.find((a) => a.item.id === dupe.id);
    expect(dupeAnn?.duplicate_of).toMatch(/retry logic/);
    expect(dupeAnn?.match).toBe("exact");
  });

  it("tags a reworded pending preference as a near-duplicate but leaves a near-miss separate", async () => {
    const root = await tempRepo();
    const { item: approved } = await addToInbox(root, {
      kind: "preference",
      text: "always add retry logic with exponential backoff to outbound network calls",
    });
    await approveInboxItem(root, approved.id);

    // TRUE near-duplicate: same rule, reworded
    const { item: near } = await addToInbox(root, {
      kind: "preference",
      text: "add retry logic with exponential backoff to outbound network calls always",
    });
    // NEAR-MISS: same topic words but a genuinely different rule
    const { item: miss } = await addToInbox(root, {
      kind: "preference",
      text: "never add caching to outbound network calls",
    });

    const annotated = await annotateInboxDuplicates(root, await loadInbox(root));
    const byId = new Map(annotated.map((a) => [a.item.id, a]));

    expect(byId.get(near.id)?.duplicate_of).toBeDefined();
    expect(byId.get(miss.id)?.duplicate_of).toBeUndefined();
  });

  it("leaves a distinct pending preference unannotated", async () => {
    const root = await tempRepo();
    const { item: approved } = await addToInbox(root, {
      kind: "preference",
      text: "always add retry logic to network calls",
    });
    await approveInboxItem(root, approved.id);
    const { item: other } = await addToInbox(root, {
      kind: "preference",
      text: "prefer four space indentation in python files",
    });
    const annotated = await annotateInboxDuplicates(root, await loadInbox(root));
    const ann = annotated.find((a) => a.item.id === other.id);
    expect(ann?.duplicate_of).toBeUndefined();
  });

  it("tags a later pending item that reworps an EARLIER pending item (same session, neither approved)", async () => {
    const root = await tempRepo();
    // First phrasing — stays actionable.
    const { item: first } = await addToInbox(root, {
      kind: "preference",
      text: "always add retry logic with exponential backoff to outbound network calls",
    });
    // Reworded copy of the same rule, also still pending (nothing approved).
    const { item: second } = await addToInbox(root, {
      kind: "preference",
      text: "add retry logic with exponential backoff to outbound network calls always",
    });
    // Genuinely different rule — must stay separate.
    const { item: distinct } = await addToInbox(root, {
      kind: "preference",
      text: "prefer four space indentation in python files",
    });

    const annotated = await annotateInboxDuplicates(root, await loadInbox(root));
    const byId = new Map(annotated.map((a) => [a.item.id, a]));

    expect(byId.get(first.id)?.duplicate_of).toBeUndefined(); // first occurrence stays clean
    expect(byId.get(second.id)?.duplicate_of).toMatch(/^pending /);
    expect(byId.get(distinct.id)?.duplicate_of).toBeUndefined();
  });

  it("tags a pending directive duplicating an active area note", async () => {
    const root = await tempRepo();
    // active area note recorded directly (e.g. via record_lesson path)
    await recordDirective(root, {
      directive: "do not log secrets in this directory",
      polarity: "dont",
      area: "src/api",
    });

    const { item: dupe } = await addToInbox(root, {
      kind: "directive",
      text: "Do not log secrets in this directory",
      polarity: "dont",
      area: "src/api",
    });
    const annotated = await annotateInboxDuplicates(root, await loadInbox(root));
    const ann = annotated.find((a) => a.item.id === dupe.id);
    expect(ann?.duplicate_of).toMatch(/area note/);
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

describe("buildInboxReview + mergeInboxDuplicates", () => {
  it("suggests a merge for near-duplicate pending items", async () => {
    const root = await tempRepo();
    const { item: first } = await addToInbox(root, {
      kind: "preference",
      text: "always add retry logic with exponential backoff to outbound network calls",
    });
    const { item: second } = await addToInbox(root, {
      kind: "preference",
      text: "add retry logic with exponential backoff to outbound network calls always",
    });

    const review = await buildInboxReview(root);
    expect(review.merge_suggestions).toHaveLength(1);
    expect(review.merge_suggestions[0]!.canonical.id).toBe(first.id);
    expect(review.merge_suggestions[0]!.duplicates.map((i) => i.id)).toEqual([second.id]);
    expect(review.merge_suggestions[0]!.command).toBe(`gps inbox merge ${first.id}`);
  });

  it("merge approves the canonical item and rejects duplicate copies", async () => {
    const root = await tempRepo();
    const { item: first } = await addToInbox(root, {
      kind: "preference",
      text: "always add retry logic with exponential backoff to outbound network calls",
    });
    const { item: second } = await addToInbox(root, {
      kind: "preference",
      text: "add retry logic with exponential backoff to outbound network calls always",
    });

    const result = await mergeInboxDuplicates(root, first.id.slice(0, 6));
    expect(result?.approved.item.id).toBe(first.id);
    expect(result?.rejected.map((i) => i.id)).toEqual([second.id]);

    const after = await loadInbox(root);
    expect(after.find((i) => i.id === first.id)?.status).toBe("approved");
    expect(after.find((i) => i.id === second.id)?.status).toBe("rejected");
    expect((await loadPreferences(root)).map((p) => p.text)).toContain(first.text);
  });

  it("surfaces risk and scope suggestions", async () => {
    const root = await tempRepo();
    const { item: risky } = await addToInbox(root, {
      kind: "preference",
      text: "always require auth before issuing payment refunds",
    });
    const { item: scoped } = await addToInbox(root, {
      kind: "preference",
      text: "in src/api never log request secrets",
    });
    const { item: noArea } = await addToInbox(root, {
      kind: "directive",
      text: "do not add comments here",
      polarity: "dont",
    });

    const review = await buildInboxReview(root);
    expect(review.risky.map((i) => i.id)).toContain(risky.id);
    expect(review.scope_suggestions.map((s) => s.item.id)).toEqual(
      expect.arrayContaining([scoped.id, noArea.id]),
    );
  });
});
