import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GPS_MCP_CONFIG, parseShellArgs, resetWorkingTree, runTask, parseMatrix, loadTasks, summarize, AGENT_PRESETS, type BenchTask, type RunResult } from "./bench.js";

const execFile = promisify(_execFile);
const roots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(d);
  return d;
}

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
});

async function gitInit(repo: string): Promise<void> {
  await execFile("git", ["-C", repo, "init", "-q", "-b", "main"]);
  await execFile("git", ["-C", repo, "config", "user.email", "bench@test"]);
  await execFile("git", ["-C", repo, "config", "user.name", "bench"]);
  await execFile("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
}

describe("parseShellArgs", () => {
  it("splits simple whitespace", () => {
    expect(parseShellArgs("claude -p")).toEqual(["claude", "-p"]);
  });
  it("preserves double-quoted args with =", () => {
    expect(parseShellArgs(`claude -p --model="claude-opus-4-7"`)).toEqual([
      "claude", "-p", "--model=claude-opus-4-7",
    ]);
  });
  it("handles single quotes literally", () => {
    expect(parseShellArgs(`sh -c 'echo hi'`)).toEqual(["sh", "-c", "echo hi"]);
  });
  it("handles spaces inside quotes", () => {
    expect(parseShellArgs(`foo "a b c" d`)).toEqual(["foo", "a b c", "d"]);
  });
  it("handles backslash escapes outside quotes", () => {
    expect(parseShellArgs(`foo a\\ b`)).toEqual(["foo", "a b"]);
  });
  it("throws on unterminated quote", () => {
    expect(() => parseShellArgs(`foo "bar`)).toThrow(/unterminated quote/);
  });
  it("collapses multiple whitespace", () => {
    expect(parseShellArgs("  a   b  ")).toEqual(["a", "b"]);
  });
});

describe("resetWorkingTree", () => {
  it("discards edits, removes untracked files, and nukes .gps/", { timeout: 30_000 }, async () => {
    const repo = await tempDir("gps-bench-reset-");
    await gitInit(repo);
    await writeFile(path.join(repo, "tracked.txt"), "original\n");
    await execFile("git", ["-C", repo, "add", "."]);
    await execFile("git", ["-C", repo, "commit", "-q", "-m", "init"]);

    // dirty everything
    await writeFile(path.join(repo, "tracked.txt"), "MUTATED\n");
    await writeFile(path.join(repo, "untracked.txt"), "leak\n");
    await mkdir(path.join(repo, ".gps"), { recursive: true });
    await writeFile(path.join(repo, ".gps/index.json"), "{}\n");
    await mkdir(path.join(repo, "newdir"), { recursive: true });
    await writeFile(path.join(repo, "newdir/x"), "x\n");

    await resetWorkingTree(repo);

    expect((await readFile(path.join(repo, "tracked.txt"), "utf8"))).toBe("original\n");
    await expect(stat(path.join(repo, "untracked.txt"))).rejects.toThrow();
    await expect(stat(path.join(repo, ".gps"))).rejects.toThrow();
    await expect(stat(path.join(repo, "newdir"))).rejects.toThrow();
  });

  it("throws loudly when path is not a git repo", { timeout: 15_000 }, async () => {
    const notRepo = await tempDir("gps-bench-notrepo-");
    await expect(resetWorkingTree(notRepo)).rejects.toThrow(/not a git repo/);
  });

  it("also scrubs .mcp.json so gps-arm config does not leak to baseline arm",
    { timeout: 30_000 }, async () => {
    const repo = await tempDir("gps-bench-mcp-leak-");
    await gitInit(repo);
    await writeFile(path.join(repo, "tracked.txt"), "ok\n");
    await execFile("git", ["-C", repo, "add", "."]);
    await execFile("git", ["-C", repo, "commit", "-q", "-m", "init"]);

    // simulate the gps arm having written .mcp.json
    await writeFile(path.join(repo, ".mcp.json"), JSON.stringify(GPS_MCP_CONFIG));

    await resetWorkingTree(repo);

    await expect(stat(path.join(repo, ".mcp.json"))).rejects.toThrow();
  });
});

describe("prompt fairness (runTask)", () => {
  // To assert "both arms get an identical prompt" without booting `claude`,
  // we use a fake agentCommand that echoes its argv into a file in cwd. The
  // test reads the recorded prompts back and asserts byte-equality.
  async function setupRecordingRepo(): Promise<{ repo: string; task: BenchTask }> {
    const repo = await tempDir("gps-bench-fair-");
    await gitInit(repo);
    await writeFile(path.join(repo, "README.md"), "fixture\n");
    await execFile("git", ["-C", repo, "add", "."]);
    await execFile("git", ["-C", repo, "commit", "-q", "-m", "init"]);

    const task: BenchTask = {
      id: "fair-test",
      repo: ".",
      // Multiline + special chars so any extra suffix on the gps arm would be
      // immediately visible as a diff between recorded files.
      prompt: "Edit src/foo.ts and add a comment.\n\nKeep it concise.",
      checks: ["true"],
    };
    return { repo, task };
  }

  it("both arms receive byte-identical prompt argv", { timeout: 30_000 }, async () => {
    const { repo, task } = await setupRecordingRepo();
    // Write records OUTSIDE repo so the next attempt's resetWorkingTree
    // (which scrubs untracked files) cannot delete them. JSON-encode the
    // path to safely embed it inside the inline node -e source.
    const outDir = await tempDir("gps-bench-fair-out-");
    // Use single-quoted wrapper for the node -e script so the inner double-
    // quoted path literal isn't terminated by parseShellArgs.
    const recorder = (tag: string): string => {
      const target = path.join(outDir, `agent-${tag}.txt`);
      return `node -e 'require("fs").writeFileSync("${target}", process.argv[1] ?? "")'`;
    };

    const baseRes = await runTask(repo, task, "baseline", 0, { agentCommand: recorder("baseline"), timeoutSec: 30 });
    const gpsRes  = await runTask(repo, task, "gps",      0, { agentCommand: recorder("gps"),      timeoutSec: 30 });
    expect(baseRes.timed_out).toBe(false);
    expect(gpsRes.timed_out).toBe(false);

    const basePrompt = await readFile(path.join(outDir, "agent-baseline.txt"), "utf8");
    const gpsPrompt  = await readFile(path.join(outDir, "agent-gps.txt"), "utf8");
    expect(basePrompt).toBe(gpsPrompt);
    expect(basePrompt).toBe(task.prompt);
    // and specifically NOT the old appended suffix
    expect(gpsPrompt).not.toMatch(/MCP server/i);
  });

  it("gps arm writes .mcp.json into the workdir; baseline arm does not",
    { timeout: 30_000 }, async () => {
    const { repo, task } = await setupRecordingRepo();
    const outDir = await tempDir("gps-bench-mcp-out-");
    // Snapshot the .mcp.json that exists in cwd at agent invocation time,
    // OUTSIDE the repo so the next attempt's reset cannot wipe the snapshot.
    const snap = (tag: string): string => {
      const target = path.join(outDir, `snap-${tag}.json`);
      return `node -e 'try{require("fs").copyFileSync(".mcp.json", "${target}")}catch(e){}'`;
    };

    await runTask(repo, task, "gps", 0, { agentCommand: snap("gps"), timeoutSec: 30 });
    // baseline must NOT see a leftover .mcp.json from the prior gps attempt
    await runTask(repo, task, "baseline", 0, { agentCommand: snap("baseline"), timeoutSec: 30 });

    const gpsSnap = await stat(path.join(outDir, "snap-gps.json")).then(() => true).catch(() => false);
    const baseSnap = await stat(path.join(outDir, "snap-baseline.json")).then(() => true).catch(() => false);
    expect(gpsSnap).toBe(true);
    expect(baseSnap).toBe(false);

    const parsed = JSON.parse(await readFile(path.join(outDir, "snap-gps.json"), "utf8"));
    expect(parsed).toEqual(GPS_MCP_CONFIG);
  });
});

describe("parseMatrix", () => {
  it("expands a comma list of known presets", () => {
    const agents = parseMatrix("opus,haiku");
    expect(agents).toHaveLength(2);
    expect(agents[0]).toEqual({ label: "opus", command: AGENT_PRESETS.opus });
    expect(agents[1]).toEqual({ label: "haiku", command: AGENT_PRESETS.haiku });
  });
  it("trims whitespace and ignores empties", () => {
    expect(parseMatrix(" sonnet , haiku ")).toHaveLength(2);
  });
  it("throws on unknown preset (typo guard)", () => {
    expect(() => parseMatrix("opus,gpt5")).toThrow(/unknown agent preset "gpt5"/);
  });
  it("throws on empty spec", () => {
    expect(() => parseMatrix("")).toThrow(/--matrix needs/);
  });
});

describe("loadTasks", () => {
  it("loads a minimal task yaml", async () => {
    const dir = await tempDir("gps-bench-tasks-");
    await writeFile(
      path.join(dir, "demo.yml"),
      "repo: examples/x\nprompt: do thing\nchecks:\n  - 'true'\n",
    );
    const tasks = await loadTasks(dir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: "demo", repo: "examples/x", prompt: "do thing" });
  });
  it("silently drops the deprecated invariants_expected key", async () => {
    const dir = await tempDir("gps-bench-tasks-");
    await writeFile(
      path.join(dir, "legacy.yml"),
      "repo: examples/x\nprompt: do\nchecks: ['true']\ninvariants_expected:\n  - foo\n",
    );
    const tasks = await loadTasks(dir);
    expect(tasks).toHaveLength(1);
    expect((tasks[0] as unknown as { invariants_expected?: unknown }).invariants_expected).toBeUndefined();
  });
  it("rejects malformed yamls", async () => {
    const dir = await tempDir("gps-bench-tasks-");
    await writeFile(path.join(dir, "bad.yml"), "prompt: only\n");
    await expect(loadTasks(dir)).rejects.toThrow(/malformed task/);
  });
  it("loads every shipped repo-edit-bench task without error", async () => {
    const tasksDir = path.resolve(__dirname, "../../../bench/repo-edit-bench/tasks");
    const tasks = await loadTasks(tasksDir);
    expect(tasks.length).toBeGreaterThanOrEqual(6);
    for (const t of tasks) {
      expect(t.repo).toBeTruthy();
      expect(t.prompt).toBeTruthy();
      expect(t.checks.length).toBeGreaterThan(0);
      // No `|| true` escape hatches — every check must be falsifiable.
      for (const c of t.checks) {
        expect(c).not.toMatch(/\|\|\s*true\b/);
      }
    }
  });
});

describe("summarize with Wilson CI and matrix", () => {
  function mkResult(agent_label: string, task_id: string, arm: "baseline" | "gps", passed: boolean): RunResult {
    return {
      task_id, arm, attempt: 0, agent_label, passed,
      failed_checks: [], duration_sec: 1, output_chars: 100, timed_out: false,
    };
  }
  it("computes per-agent cells and a Wilson CI on each", () => {
    const results: RunResult[] = [
      mkResult("opus", "t1", "baseline", true),
      mkResult("opus", "t1", "gps", true),
      mkResult("haiku", "t1", "baseline", false),
      mkResult("haiku", "t1", "gps", true),
    ];
    const s = summarize(results, 1, ["opus", "haiku"]);
    expect(s.agents).toEqual(["opus", "haiku"]);
    expect(s.cells).toHaveLength(4);
    const haikuGps = s.cells.find((c) => c.agent_label === "haiku" && c.arm === "gps");
    expect(haikuGps?.pass_rate).toBe(1);
    expect(haikuGps?.pass_rate_ci.low).toBeGreaterThan(0);
    expect(haikuGps?.pass_rate_ci.high).toBe(1);
    const haikuBase = s.cells.find((c) => c.agent_label === "haiku" && c.arm === "baseline");
    expect(haikuBase?.pass_rate).toBe(0);
    const perTaskHaiku = s.per_task.find((r) => r.agent_label === "haiku");
    expect(perTaskHaiku?.delta).toBe(1);
  });
  it("warns at n<3 only", () => {
    const s2 = summarize([mkResult("x", "t", "baseline", true)], 2);
    expect(s2.warnings.join(" ")).toMatch(/below 3/);
    const s5 = summarize([mkResult("x", "t", "baseline", true)], 5);
    expect(s5.warnings).toEqual([]);
  });
});
