import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCmd, resolvePolicy, runInstallClaude, runInstallCodex } from "./install.js";

describe("resolveCmd", () => {
  it("errors when both --use-global and --use-local are passed", () => {
    expect(() => resolveCmd({ useGlobal: true, useLocal: true })).toThrow(
      /mutually exclusive/,
    );
  });

  it("returns the global shape under --use-global", () => {
    const spec = resolveCmd({ useGlobal: true });
    expect(spec.mode).toBe("global");
    expect(spec.shell).toBe("gps");
    expect(spec.command).toBe("gps");
    expect(spec.baseArgs).toEqual([]);
  });

  it("under --use-local in dev (tsx/vitest) throws with a build hint", () => {
    // Tests run against .ts source, so the running script doesn't end in .js
    // and localBinPath() correctly returns null. The error must tell the user
    // what to do — that hint is the whole point of failing fast here.
    expect(() => resolveCmd({ useLocal: true })).toThrow(/pnpm -r build/);
  });

  it("respects CI=1 → default to npx mode regardless of workspace detection", () => {
    const prev = process.env.CI;
    process.env.CI = "1";
    try {
      const spec = resolveCmd({});
      expect(spec.mode).toBe("npx");
      expect(spec.command).toBe("npx");
      expect(spec.baseArgs).toEqual(["-y", "@invariance/gps"]);
      expect(spec.shell).toBe("npx -y @invariance/gps");
    } finally {
      if (prev === undefined) delete process.env.CI;
      else process.env.CI = prev;
    }
  });

  it("falls back to npx in dev (no built dist to detect) when no flags given", () => {
    const prev = process.env.CI;
    delete process.env.CI;
    try {
      // Under vitest the running script is .ts, so workspace auto-detect can't
      // resolve a built bin and we land on the npx default. Once dist exists
      // and is outside node_modules, auto-detect would pick local instead.
      const spec = resolveCmd({});
      expect(spec.mode).toBe("npx");
    } finally {
      if (prev !== undefined) process.env.CI = prev;
    }
  });
});

describe("resolvePolicy", () => {
  it("defaults to capture=auto / promote=never with no flags", () => {
    expect(resolvePolicy({})).toEqual({
      capture: "auto",
      promote: "never",
      auto_suggest: false,
    });
  });

  it("accepts --capture=inbox", () => {
    expect(resolvePolicy({ capture: "inbox" })).toEqual({
      capture: "inbox",
      promote: "never",
      auto_suggest: false,
    });
  });

  it("accepts --capture=auto --promote=all", () => {
    expect(resolvePolicy({ capture: "auto", promote: "all" })).toEqual({
      capture: "auto",
      promote: "all",
      auto_suggest: false,
    });
  });

  it("accepts --auto-suggest as an explicit feature flag", () => {
    expect(resolvePolicy({ autoSuggest: true })).toEqual({
      capture: "auto",
      promote: "never",
      auto_suggest: true,
    });
  });

  it("rejects --promote without --capture=auto", () => {
    expect(() => resolvePolicy({ capture: "inbox", promote: "safe" })).toThrow(
      /requires --capture=auto/,
    );
    // promote given while capture defaults to auto is fine; promote given with
    // an explicit non-auto capture is the error case
    expect(() => resolvePolicy({ promote: "safe" })).not.toThrow();
  });

  it("rejects invalid enum values", () => {
    expect(() => resolvePolicy({ capture: "bogus" })).toThrow(/invalid --capture/);
    expect(() => resolvePolicy({ promote: "bogus" })).toThrow(/invalid --promote/);
  });
});

describe("install codex: notifyArgs contains --capture-prefs", () => {
  it("Codex config.toml notify line includes --capture-prefs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gps-install-codex-test-"));
    const spec = resolveCmd({ useGlobal: true });
    await runInstallCodex(root, { force: true, skipAgentsMd: true, spec });
    const config = await readFile(path.join(root, ".codex/config.toml"), "utf8");
    expect(config).toContain("--capture-prefs");
    expect(config).toContain("--transcript");
    expect(config).toContain('"-"');
  });
});

describe("install codex: auto suggestions enable observation", () => {
  it("Codex MCP server args include --observe when auto suggestions are enabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gps-install-codex-observe-test-"));
    const spec = resolveCmd({ useGlobal: true });
    await runInstallCodex(root, {
      force: true,
      skipAgentsMd: true,
      spec,
      autoSuggest: true,
    });
    const config = await readFile(path.join(root, ".codex/config.toml"), "utf8");
    expect(config).toContain('"serve", "--observe"');
  });
});

describe("install claude: Stop hook does NOT contain --capture-prefs", () => {
  it("Claude .claude/settings.json Stop hook does not include --capture-prefs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gps-install-claude-test-"));
    const spec = resolveCmd({ useGlobal: true });
    await runInstallClaude(root, { force: true, skipClaudeMd: true, spec });
    const settings = await readFile(path.join(root, ".claude/settings.json"), "utf8");
    const parsed = JSON.parse(settings) as { hooks?: { Stop?: Array<{ hooks?: Array<{ command?: string }> }> } };
    const stopHooks = parsed.hooks?.Stop ?? [];
    for (const hookGroup of stopHooks) {
      for (const hook of hookGroup.hooks ?? []) {
        if (hook.command) {
          expect(hook.command).not.toContain("--capture-prefs");
        }
      }
    }
  });
});

describe("install claude: Stop hook contains feature-flagged suggestions", () => {
  it("Claude .claude/settings.json Stop hook runs `gps suggest --auto`", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gps-install-claude-suggest-test-"));
    const spec = resolveCmd({ useGlobal: true });
    await runInstallClaude(root, { force: true, skipClaudeMd: true, spec });
    const settings = await readFile(path.join(root, ".claude/settings.json"), "utf8");
    expect(settings).toContain("suggest --auto");
  });
});
