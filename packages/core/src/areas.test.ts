import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import {
  bindAliasLocation,
  areaForPath,
  resolveActiveArea,
  matchAliasesInPrompt,
  upsertAlias,
  loadAliases,
} from "./areas.js";
import { loadFeatures, setActive } from "./features.js";
import { classifyHeuristic } from "./lessons.js";
import { recordDirective } from "./lessons.js";
import { loadAreaNotes } from "./notes.js";
import type { AliasBinding, FeaturesFile } from "@invariance/gps-schemas";

const roots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gps-areas-"));
  roots.push(root);
  return root;
}

function alias(name: string, patch: Partial<AliasBinding> = {}): AliasBinding {
  const now = new Date().toISOString();
  return {
    name,
    source: "auto",
    created_at: now,
    last_resolved: now,
    hits: 0,
    ...patch,
  };
}

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    if (r) await rm(r, { recursive: true, force: true });
  }
});

describe("classifyHeuristic — area scope", () => {
  it("classifies a positional directive as area when an active area is given", () => {
    const r = classifyHeuristic("don't use inline styles here", {
      activeArea: "src/pages/home",
    });
    expect(r.scope).toBe("area");
    expect(r.target).toBe("src/pages/home");
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("flags positional phrasing ambiguous when no active area resolves", () => {
    const r = classifyHeuristic("don't use inline styles here");
    expect(r.scope).not.toBe("area");
    expect(r.ambiguous).toBe(true);
  });

  it("classifies a lone alias mention as area", () => {
    const aliases = { home: alias("home", { dir: "src/pages/home" }) };
    const r = classifyHeuristic("tighten the spacing in home", { aliases });
    expect(r.scope).toBe("area");
    expect(r.target).toBe("src/pages/home");
  });
});

describe("bindAliasLocation", () => {
  it("binds an alias from a single edited file", () => {
    const features: FeaturesFile = {
      version: 1,
      features: {},
      aliases: { home: alias("home") },
    };
    const bound = bindAliasLocation(features, ["src/pages/home/index.tsx"], "homepage");
    expect(bound).toEqual(["home"]);
    expect(features.aliases.home?.file).toBe("src/pages/home/index.tsx");
    expect(features.aliases.home?.dir).toBe("src/pages/home");
    expect(features.aliases.home?.feature).toBe("homepage");
  });

  it("binds via basename fuzzy-match even with several edited files", () => {
    const features: FeaturesFile = {
      version: 1,
      features: {},
      aliases: { home: alias("home") },
    };
    const bound = bindAliasLocation(features, [
      "src/util.ts",
      "src/pages/Home.tsx",
      "src/styles.css",
    ]);
    expect(bound).toEqual(["home"]);
    expect(features.aliases.home?.file).toBe("src/pages/Home.tsx");
    expect(features.aliases.home?.dir).toBe("src/pages");
  });

  it("does not overwrite an already-bound alias", () => {
    const features: FeaturesFile = {
      version: 1,
      features: {},
      aliases: { home: alias("home", { file: "src/old.tsx", dir: "src" }) },
    };
    const bound = bindAliasLocation(features, ["src/pages/new.tsx"]);
    expect(bound).toEqual([]);
    expect(features.aliases.home?.file).toBe("src/old.tsx");
  });
});

describe("areaForPath", () => {
  it("returns the deepest registered area containing the path", async () => {
    const root = await tempRepo();
    await upsertAlias(root, "pages", { dir: "src/pages" });
    await upsertAlias(root, "home", { dir: "src/pages/home" });
    expect(await areaForPath(root, "src/pages/home/Nav.tsx")).toBe("src/pages/home");
    expect(await areaForPath(root, "src/pages/about.tsx")).toBe("src/pages");
    expect(await areaForPath(root, "src/lib/x.ts")).toBeUndefined();
  });

  it("strips glob magic from the searched pattern", async () => {
    const root = await tempRepo();
    await upsertAlias(root, "home", { dir: "src/pages/home" });
    expect(await areaForPath(root, "src/pages/home/**/*.tsx")).toBe("src/pages/home");
  });
});

describe("resolveActiveArea", () => {
  it("prefers an explicit alias hint", async () => {
    const root = await tempRepo();
    await upsertAlias(root, "home", { dir: "src/pages/home" });
    expect(await resolveActiveArea(root, "home")).toBe("src/pages/home");
  });

  it("treats an unknown hint as a directory path", async () => {
    const root = await tempRepo();
    expect(await resolveActiveArea(root, "src/widgets/")).toBe("src/widgets");
  });

  it("falls back to the active feature's bound alias dir", async () => {
    const root = await tempRepo();
    await setActive(root, "homepage");
    await upsertAlias(root, "home", { dir: "src/pages/home", feature: "homepage" });
    expect(await resolveActiveArea(root)).toBe("src/pages/home");
  });

  it("returns undefined when nothing resolves", async () => {
    const root = await tempRepo();
    expect(await resolveActiveArea(root)).toBeUndefined();
  });
});

describe("matchAliasesInPrompt", () => {
  it("word-boundary matches alias names", () => {
    const aliases = {
      home: alias("home", { dir: "src/home" }),
      "auth-flow": alias("auth-flow", { dir: "src/auth" }),
    };
    expect(matchAliasesInPrompt("let's work on home today", aliases)).toEqual(["home"]);
    expect(matchAliasesInPrompt("the homepage redesign", aliases)).toEqual([]);
    expect(matchAliasesInPrompt("fix the auth-flow", aliases)).toEqual(["auth-flow"]);
  });
});

describe("loadFeatures backward-compat", () => {
  it("parses a features.yml with no aliases key", async () => {
    const root = await tempRepo();
    await mkdir(path.join(root, ".gps"), { recursive: true });
    await writeFile(
      path.join(root, ".gps/features.yml"),
      stringifyYaml({ version: 1, features: {} }),
    );
    const features = await loadFeatures(root);
    expect(features.aliases).toEqual({});
  });
});

describe("recordDirective", () => {
  it("persists an area note and binds an alias", async () => {
    const root = await tempRepo();
    const result = await recordDirective(root, {
      directive: "don't add new dependencies here",
      area: "src/pages/home",
      alias: "home",
    });
    expect(result.scope).toBe("area");
    expect(result.area).toBe("src/pages/home");
    expect(result.polarity).toBe("dont");
    expect(result.alias).toBe("home");

    const notes = await loadAreaNotes(root, "src/pages/home");
    expect(notes.map((n) => n.lesson)).toContain("don't add new dependencies here");

    const aliases = await loadAliases(root);
    expect(aliases.home?.dir).toBe("src/pages/home");
    expect(aliases.home?.source).toBe("user");
  });

  it("throws a helpful error when no area can be resolved", async () => {
    const root = await tempRepo();
    await expect(
      recordDirective(root, { directive: "avoid magic numbers here" }),
    ).rejects.toThrow(/could not resolve an area/);
  });
});
