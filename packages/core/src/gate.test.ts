import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gate } from "./gate.js";
import { appendWaiver } from "./waivers.js";
import { writeIndex, type GpsIndex } from "./index_store.js";

const roots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-gate-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
});

async function seedInvariants(root: string, body: string): Promise<void> {
  await mkdir(path.join(root, ".gps"), { recursive: true });
  await writeFile(path.join(root, ".gps/invariants.yml"), body);
}

async function seedIndex(root: string): Promise<void> {
  const idx: GpsIndex = {
    version: 1,
    built_at: new Date().toISOString(),
    root,
    files: ["src/refunds.ts"],
    symbols: [
      {
        id: "src/refunds.ts#createRefund:10",
        name: "createRefund",
        qualified_name: "createRefund",
        file: "src/refunds.ts",
        line: 10,
        kind: "function",
      },
    ],
    edges: [],
  };
  await writeIndex(root, idx);
}

describe("gate", () => {
  it("flags a blocking invariant when a matched symbol is in the diff", async () => {
    const root = await tempRepo();
    await seedIndex(root);
    await seedInvariants(
      root,
      `- name: refund-cap\n  applies_to: [createRefund]\n  rule: refunds must be capped\n  severity: block\n`,
    );

    const result = await gate(root, { files: ["src/refunds.ts"] });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.invariant.name).toBe("refund-cap");
    expect(result.blocking).toHaveLength(1);
  });

  it("does not flag when no changed file maps to the invariant's symbols", async () => {
    const root = await tempRepo();
    await seedIndex(root);
    await seedInvariants(
      root,
      `- name: refund-cap\n  applies_to: [createRefund]\n  rule: refunds must be capped\n  severity: block\n`,
    );
    const result = await gate(root, { files: ["src/other.ts"] });
    expect(result.hits).toHaveLength(0);
    expect(result.blocking).toHaveLength(0);
  });

  it("clears blocking when a waiver exists", async () => {
    const root = await tempRepo();
    await seedIndex(root);
    await seedInvariants(
      root,
      `- name: refund-cap\n  applies_to: [createRefund]\n  rule: refunds must be capped\n  severity: block\n`,
    );
    await appendWaiver(root, { invariant: "refund-cap", reason: "policy change" });
    const result = await gate(root, { files: ["src/refunds.ts"] });
    expect(result.hits[0]!.waived).toBe(true);
    expect(result.blocking).toHaveLength(0);
  });
});
