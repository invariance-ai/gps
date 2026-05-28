import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GpsPolicy } from "@invariance/gps-schemas";
import { loadConfig, loadPolicy, writePolicy } from "./scan.js";

const roots: string[] = [];
async function tempRepo(configBody?: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-scan-"));
  roots.push(root);
  if (configBody !== undefined) {
    await mkdir(path.join(root, ".gps"), { recursive: true });
    await writeFile(path.join(root, ".gps/config.yml"), configBody);
  }
  return root;
}
afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
});

describe("loadConfig — policy defaults", () => {
  it("defaults to capture=auto / promote=safe / auto_suggest=false when no config file exists", async () => {
    const root = await tempRepo();
    const cfg = await loadConfig(root);
    expect(cfg.capture).toBe("auto");
    expect(cfg.promote).toBe("safe");
    expect(cfg.auto_suggest).toBe(false);
    expect(cfg.experimental).toEqual({ live_docs: false });
  });

  it("defaults policy when config file omits the fields", async () => {
    const root = await tempRepo("languages: [typescript]\ndepth: 5\n");
    const cfg = await loadConfig(root);
    expect(cfg.capture).toBe("auto");
    expect(cfg.promote).toBe("safe");
    expect(cfg.auto_suggest).toBe(false);
    expect(cfg.experimental.live_docs).toBe(false);
    // non-policy fields still parse
    expect(cfg.languages).toEqual(["typescript"]);
    expect(cfg.depth).toBe(5);
  });

  it("parses explicit policy fields without disturbing other config", async () => {
    const root = await tempRepo(
      "languages: [typescript, python]\nexclude:\n  - tmp\ndepth: 3\ncapture: inbox\npromote: safe\n",
    );
    const cfg = await loadConfig(root);
    expect(cfg.capture).toBe("inbox");
    expect(cfg.promote).toBe("safe");
    expect(cfg.auto_suggest).toBe(false);
    expect(cfg.experimental.live_docs).toBe(false);
    expect(cfg.languages).toEqual(["typescript", "python"]);
    expect(cfg.exclude).toContain("tmp");
  });

  it("parses experimental feature flags explicitly", async () => {
    const root = await tempRepo("experimental:\n  live_docs: true\n");
    const cfg = await loadConfig(root);
    expect(cfg.experimental.live_docs).toBe(true);
  });
});

describe("GpsPolicy schema", () => {
  it("yields locked defaults on empty input", () => {
    expect(GpsPolicy.parse({})).toEqual({
      capture: "auto",
      promote: "safe",
      auto_suggest: false,
    });
  });

  it("rejects invalid enum values", () => {
    expect(() => GpsPolicy.parse({ promote: "bogus" })).toThrow();
    expect(() => GpsPolicy.parse({ capture: "bogus" })).toThrow();
  });
});

describe("loadPolicy", () => {
  it("returns just the policy", async () => {
    const root = await tempRepo("capture: inbox\npromote: all\nauto_suggest: true\n");
    expect(await loadPolicy(root)).toEqual({
      capture: "inbox",
      promote: "all",
      auto_suggest: true,
    });
  });
});

describe("writePolicy", () => {
  it("merges policy into config.yml, preserving other keys", async () => {
    const root = await tempRepo(
      "languages: [typescript, python]\nexclude:\n  - tmp\ndepth: 4\nstrands:\n  - structural\n",
    );
    await writePolicy(root, GpsPolicy.parse({ capture: "inbox", promote: "never" }));
    const cfg = await loadConfig(root);
    expect(cfg.capture).toBe("inbox");
    expect(cfg.auto_suggest).toBe(false);
    expect(cfg.languages).toEqual(["typescript", "python"]);
    expect(cfg.depth).toBe(4);
    expect(cfg.exclude).toContain("tmp");
    expect(cfg.strands).toEqual(["structural"]);
  });

  it("creates config.yml when none exists", async () => {
    const root = await tempRepo();
    await writePolicy(
      root,
      GpsPolicy.parse({ capture: "auto", promote: "safe", auto_suggest: true }),
    );
    expect(await loadPolicy(root)).toEqual({
      capture: "auto",
      promote: "safe",
      auto_suggest: true,
    });
  });
});
