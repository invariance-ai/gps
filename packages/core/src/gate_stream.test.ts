import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendGateStreamEntry,
  gateStreamPath,
  readGateStream,
} from "./gate_stream.js";

describe("gate_stream seq cursor", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "gps-gate-stream-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("assigns monotonic seq when appending one-shot entries", async () => {
    const base = {
      ts: new Date().toISOString(),
      changed_files: ["a.ts"],
      changed_symbols: ["foo"],
      hits: [],
      blocking: [],
    };
    const e1 = await appendGateStreamEntry(root, base);
    const e2 = await appendGateStreamEntry(root, base);
    const e3 = await appendGateStreamEntry(root, base);
    expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3]);
  });

  it("filters by since_seq (preferred over since)", async () => {
    const base = {
      ts: "2020-01-01T00:00:00Z",
      changed_files: ["a.ts"],
      changed_symbols: ["foo"],
      hits: [],
      blocking: [],
    };
    await appendGateStreamEntry(root, base);
    await appendGateStreamEntry(root, base);
    await appendGateStreamEntry(root, base);
    const tail = await readGateStream(root, { since_seq: 1 });
    expect(tail.map((e) => e.seq)).toEqual([2, 3]);

    // since_seq wins over since
    const tail2 = await readGateStream(root, {
      since_seq: 2,
      since: "1900-01-01T00:00:00Z",
    });
    expect(tail2.map((e) => e.seq)).toEqual([3]);
  });

  it("treats legacy entries without seq as seq=0", async () => {
    const p = gateStreamPath(root);
    await mkdir(path.dirname(p), { recursive: true });
    const legacy = {
      ts: "2020-01-01T00:00:00Z",
      changed_files: ["a.ts"],
      changed_symbols: [],
      hits: [],
      blocking: [],
    };
    await writeFile(p, JSON.stringify(legacy) + "\n");
    const entries = await readGateStream(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.seq).toBe(0);
    // since_seq:0 excludes legacy entries (seq must be > 0)
    expect(await readGateStream(root, { since_seq: 0 })).toEqual([]);
  });
});
