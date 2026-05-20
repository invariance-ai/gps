import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyHeuristic, persistLesson, listLessons, reclassifyLesson } from "./lessons.js";
import {
  upsertGlobalLesson,
  readGlobalLessons,
  LESSONS_OPEN,
  LESSONS_CLOSE,
} from "./claude_md.js";
import { writeIndex, type GpsIndex } from "./index_store.js";

const roots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-lessons-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
});

describe("classifyHeuristic", () => {
  it("labels generic policy text as global", () => {
    const r = classifyHeuristic("Always run pnpm i after editing package.json");
    expect(r.scope).toBe("global");
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("labels a single symbol mention as symbol", () => {
    const idx: GpsIndex = {
      version: 1,
      built_at: "",
      root: "",
      files: [],
      symbols: [{ name: "createRefund", file: "x.ts", line: 1, kind: "function" }],
      edges: [],
    };
    const r = classifyHeuristic("createRefund must pass idempotency-key to Stripe", { index: idx });
    expect(r.scope).toBe("symbol");
    expect(r.target).toBe("createRefund");
  });

  it("labels file-path mention with no symbols as file", () => {
    const idx: GpsIndex = {
      version: 1,
      built_at: "",
      root: "",
      files: ["apps/api/handlers/refund.ts"],
      symbols: [],
      edges: [],
    };
    const r = classifyHeuristic(
      "Handlers in apps/api/handlers/refund.ts validate input with zod.",
      { index: idx },
    );
    expect(r.scope).toBe("file");
    expect(r.target).toBe("apps/api/handlers/refund.ts");
  });

  it("returns ambiguous=true for empty-context lessons", () => {
    const r = classifyHeuristic("Watch out for that thing.");
    expect(r.ambiguous).toBe(true);
  });
});

describe("CLAUDE.md global block", () => {
  it("upsert is idempotent by id and preserves bytes outside the block", async () => {
    const root = await tempRepo();
    const file = path.join(root, "CLAUDE.md");
    await writeFile(file, "# Project\n\nUser content here.\n");

    await upsertGlobalLesson(root, {
      id: "abc123",
      lesson: "Always use the project logger.",
      severity: "high",
      recorded_at: "2026-05-11",
    });
    const after1 = await readFile(file, "utf8");
    expect(after1).toContain("User content here.");
    expect(after1).toContain(LESSONS_OPEN);
    expect(after1).toContain(LESSONS_CLOSE);

    // Upsert same id with different wording — should replace, not duplicate.
    await upsertGlobalLesson(root, {
      id: "abc123",
      lesson: "Always use the project logger, never console.log.",
      severity: "high",
      recorded_at: "2026-05-11",
    });
    const lessons = await readGlobalLessons(root);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.lesson).toContain("never console.log");

    const after2 = await readFile(file, "utf8");
    expect(after2).toContain("User content here.");
  });
});

describe("persistLesson + listLessons + reclassifyLesson", () => {
  it("symbol scope writes to .gps/notes and is listable", async () => {
    const root = await tempRepo();
    const idx: GpsIndex = {
      version: 1,
      built_at: "",
      root,
      files: ["src/refund.ts"],
      symbols: [{ name: "createRefund", file: "src/refund.ts", line: 1, kind: "function" }],
      edges: [],
    };
    await writeIndex(root, idx);
    const res = await persistLesson(root, {
      scope: "symbol",
      target: "createRefund",
      lesson: "Always pass idempotency-key.",
      severity: "high",
    });
    expect(res.scope).toBe("symbol");
    expect(res.path).toContain(".gps/notes/createRefund.yml");

    const lessons = await listLessons(root);
    expect(lessons.find((l) => l.id === res.id)).toBeTruthy();
  });

  it("global → symbol reclassify removes from CLAUDE.md and writes a note", async () => {
    const root = await tempRepo();
    // Force promotion via gate override so the test exercises the global path.
    const written = await persistLesson(root, {
      scope: "global",
      lesson: "Prefer composition over inheritance.",
      gate: { countGate: 1 },
    });
    expect(written.scope).toBe("global");

    const moved = await reclassifyLesson(root, {
      id: written.id,
      to_scope: "symbol",
      to_target: "MyClass",
    });
    expect(moved.from_scope).toBe("global");
    expect(moved.to_scope).toBe("symbol");

    const claudeMd = await readFile(path.join(root, "CLAUDE.md"), "utf8");
    expect(claudeMd).not.toContain(written.id);

    const lessons = await listLessons(root, { scope: "symbol" });
    expect(lessons.find((l) => l.id === written.id)).toBeTruthy();
  });

  it("global lesson below confidence gate stays out of CLAUDE.md", async () => {
    const root = await tempRepo();
    const first = await persistLesson(root, {
      scope: "global",
      lesson: "Prefer terse responses with no trailing summaries.",
      classifier: { signals: ["heuristic"], confidence: 0.6, used_llm: false },
    });
    expect(first.promoted).toBe(false);
    expect(first.scope).toBe("file");

    const claudeRaw = await readFile(path.join(root, "CLAUDE.md"), "utf8").catch(() => "");
    expect(claudeRaw).not.toContain(first.id);
  });

  it("global lesson promotes on second high-confidence observation", async () => {
    const root = await tempRepo();
    const text = "Always run pnpm test before pushing.";
    const first = await persistLesson(root, {
      scope: "global",
      lesson: text,
      classifier: { signals: ["heuristic"], confidence: 0.9, used_llm: false },
    });
    expect(first.promoted).toBe(false);

    const second = await persistLesson(root, {
      scope: "global",
      lesson: text,
      classifier: { signals: ["heuristic"], confidence: 0.9, used_llm: false },
    });
    expect(second.promoted).toBe(true);
    expect(second.scope).toBe("global");

    const claudeRaw = await readFile(path.join(root, "CLAUDE.md"), "utf8");
    expect(claudeRaw).toContain(text);
  });
});
