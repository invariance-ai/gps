import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendQuestion,
  filterByStatus,
  loadAllQuestions,
  loadQuestions,
  setStatus,
} from "./questions.js";

const roots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-questions-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("questions primitive", () => {
  it("appends, lists, and resolves a question", async () => {
    const root = await tempRepo();
    const { question } = await appendQuestion(root, {
      symbol: "createRefund",
      question: "crypto settlements?",
      asked_by: "hardik",
    });
    expect(question.status).toBe("unresolved");
    expect(question.id).toMatch(/[0-9a-f-]+/);

    const loaded = await loadQuestions(root, "createRefund");
    expect(loaded.length).toBe(1);

    const updated = await setStatus(
      root,
      "createRefund",
      question.id,
      "resolved",
      "treat as fiat conversion",
    );
    expect(updated?.status).toBe("resolved");
    expect(updated?.resolution).toBe("treat as fiat conversion");
    expect(updated?.resolved_at).toBeDefined();
  });

  it("sanitizes symbol names for filenames so dotted/path symbols round-trip", async () => {
    const root = await tempRepo();
    await appendQuestion(root, {
      symbol: "Stripe.refunds.create",
      question: "what about JPY?",
    });
    const loaded = await loadQuestions(root, "Stripe.refunds.create");
    expect(loaded.length).toBe(1);
    expect(loaded[0]?.symbol).toBe("Stripe.refunds.create");
  });

  it("loadAllQuestions returns questions across files; filterByStatus narrows", async () => {
    const root = await tempRepo();
    const a = await appendQuestion(root, { symbol: "a", question: "?" });
    await appendQuestion(root, { symbol: "b", question: "?" });
    await setStatus(root, "a", a.question.id, "resolved");
    const all = await loadAllQuestions(root);
    expect(all.length).toBe(2);
    const unresolved = filterByStatus(all, "unresolved");
    expect(unresolved.map((q) => q.symbol)).toEqual(["b"]);
  });
});
