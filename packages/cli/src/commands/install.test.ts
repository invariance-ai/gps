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

  it("defaults to npx mode with no flags (portable, no absolute path)", () => {
    // npx is the only mode safe to commit: a published package reference, never
    // a machine-specific path. This is the default regardless of where gps runs
    // from — there is no longer a silent workspace→local auto-detect.
    const spec = resolveCmd({});
    expect(spec.mode).toBe("npx");
    expect(spec.command).toBe("npx");
    expect(spec.baseArgs).toEqual(["-y", "@invariance/gps"]);
    expect(spec.shell).toBe("npx -y @invariance/gps");
  });

  it("ignores CI and an explicit root when defaulting to npx", () => {
    // The default no longer keys off process.env.CI or workspace detection, and
    // the root arg only matters for --use-local's relative path.
    const prev = process.env.CI;
    delete process.env.CI;
    try {
      expect(resolveCmd({}).mode).toBe("npx");
      expect(resolveCmd({}, "/any/root").mode).toBe("npx");
      process.env.CI = "1";
      expect(resolveCmd({}).mode).toBe("npx");
    } finally {
      if (prev === undefined) delete process.env.CI;
      else process.env.CI = prev;
    }
  });
});

// Regression guard for the footgun this fixes: the generated, committed config
// (.claude/settings.json + .mcp.json) must never embed an absolute, machine-
// specific path. Default and --use-global modes are the only ones meant to be
// committed, so both must stay path-free.
describe("install claude: generated config is portable (no absolute paths)", () => {
  const ABSOLUTE_PATH = /(?:^|["\s])(?:\/[^"\s]+|[A-Za-z]:\\)/m;

  for (const spec of [resolveCmd({}), resolveCmd({ useGlobal: true })]) {
    it(`${spec.mode} mode embeds no absolute path in settings.json or .mcp.json`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), `gps-portable-${spec.mode}-`));
      await runInstallClaude(root, { force: true, skipClaudeMd: true, spec });
      const settings = await readFile(path.join(root, ".claude/settings.json"), "utf8");
      const mcp = await readFile(path.join(root, ".mcp.json"), "utf8");
      // The hook/MCP command is the portable reference, not a filesystem path.
      expect(settings).toContain(spec.shell);
      expect(mcp).toContain(spec.command);
      expect(settings).not.toMatch(ABSOLUTE_PATH);
      expect(mcp).not.toMatch(ABSOLUTE_PATH);
      // Belt-and-suspenders: no dist entrypoint leaked in either file.
      expect(settings).not.toContain("dist/index.js");
      expect(mcp).not.toContain("dist/index.js");
    });
  }
});

describe("resolvePolicy", () => {
  it("defaults to capture=auto / promote=safe with no flags", () => {
    expect(resolvePolicy({})).toEqual({
      capture: "auto",
      promote: "safe",
      auto_suggest: false,
    });
  });

  it("defaults --capture=inbox to promote=never", () => {
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
      promote: "safe",
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

describe("install claude: SessionStart runs periodic prune", () => {
  it("Claude .claude/settings.json SessionStart hook runs `gps prune --auto`", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gps-install-claude-prune-test-"));
    const spec = resolveCmd({ useGlobal: true });
    await runInstallClaude(root, { force: true, skipClaudeMd: true, spec });
    const settings = await readFile(path.join(root, ".claude/settings.json"), "utf8");
    expect(settings).toContain("prune --root");
    expect(settings).toContain("--auto --quiet");
  });
});
