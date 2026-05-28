import fg from "fast-glob";
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  GpsPolicy,
  DocConfig,
  type CaptureMode,
  type PromoteMode,
  type DocConfig as DocConfigT,
} from "@invariance/gps-schemas";
import {
  TS_GLOB,
  PY_GLOB,
  GO_GLOB,
  RUST_GLOB,
  JAVA_GLOB,
  RUBY_GLOB,
  CSHARP_GLOB,
} from "./parser.js";

export type GpsLanguage =
  | "typescript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "ruby"
  | "csharp";

export interface GpsConfig {
  languages: GpsLanguage[];
  exclude: string[];
  depth: number;
  strands: Array<"structural" | "tests" | "provenance" | "invariants">;
  /** Where freshly captured memory lands (see GpsPolicy). Default: "auto". */
  capture: CaptureMode;
  /** Auto-promotion policy for note clusters. Default: "never". */
  promote: PromoteMode;
  /** Whether hooks may print `gps suggest` authoring-queue nudges. Default: false. */
  auto_suggest: boolean;
  /** Doc-store feature config (shareable HTML/markdown docs). Default: all-off. */
  doc: DocConfigT;
}

const GLOBS_BY_LANG: Record<GpsLanguage, string[]> = {
  typescript: TS_GLOB,
  python: PY_GLOB,
  go: GO_GLOB,
  rust: RUST_GLOB,
  java: JAVA_GLOB,
  ruby: RUBY_GLOB,
  csharp: CSHARP_GLOB,
};

const DEFAULT_EXCLUDE = [
  "node_modules", "dist", "build", ".next", "out",
  "vendor", "__pycache__", ".venv", ".git", "coverage",
  ".gps",
];

export async function loadConfig(root: string): Promise<GpsConfig> {
  try {
    const raw = await readFile(path.join(root, ".gps/config.yml"), "utf8");
    const data = parseYaml(raw) ?? {};
    // Policy fields may be absent in old config files; Zod fills the current
    // locked defaults (auto / safe) so missing keys remain valid.
    const policy = GpsPolicy.parse({
      capture: data.capture,
      promote: data.promote,
      auto_suggest: data.auto_suggest,
    });
    return {
      languages: data.languages ?? (["typescript", "python", "go", "rust", "java", "ruby", "csharp"] as GpsLanguage[]),
      exclude: [...DEFAULT_EXCLUDE, ...(data.exclude ?? [])],
      depth: data.depth ?? 3,
      strands: data.strands ?? ["structural", "tests", "provenance", "invariants"],
      capture: policy.capture,
      promote: policy.promote,
      auto_suggest: policy.auto_suggest,
      doc: DocConfig.parse(data.doc ?? {}),
    };
  } catch {
    const policy = GpsPolicy.parse({});
    return {
      languages: ["typescript", "python", "go", "rust", "java", "ruby", "csharp"],
      exclude: DEFAULT_EXCLUDE,
      depth: 3,
      strands: ["structural", "tests", "provenance", "invariants"],
      capture: policy.capture,
      promote: policy.promote,
      auto_suggest: policy.auto_suggest,
      doc: DocConfig.parse({}),
    };
  }
}

/**
 * Thin reader for just the doc-store config. `gps doc` and the attach hook use
 * this instead of pulling the whole scan config. A repo with no `doc:` block
 * (the default) yields an all-disabled config, so the feature is opt-in.
 */
export async function loadDocConfig(root: string): Promise<DocConfigT> {
  return (await loadConfig(root)).doc;
}

/**
 * Thin reader for just the capture/promote policy. Capture and promotion
 * consumers use this instead of pulling the whole scan config.
 */
export async function loadPolicy(root: string): Promise<GpsPolicy> {
  const cfg = await loadConfig(root);
  return GpsPolicy.parse({
    capture: cfg.capture,
    promote: cfg.promote,
    auto_suggest: cfg.auto_suggest,
  });
}

/**
 * Merge the capture/promote policy into `.gps/config.yml`, preserving every
 * other key (languages/exclude/depth/strands/quality/…) verbatim. The file is
 * round-tripped through the YAML parser, so hand-authored comments and flow
 * style are not preserved — only the values survive. `gps install` calls this.
 */
export async function writePolicy(root: string, policy: GpsPolicy): Promise<void> {
  const file = path.join(root, ".gps/config.yml");
  let existing: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
  } catch {
    // no config yet — create one
  }
  const next = {
    ...existing,
    capture: policy.capture,
    promote: policy.promote,
    auto_suggest: policy.auto_suggest,
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stringifyYaml(next));
}

export async function scanFiles(root: string, config: GpsConfig): Promise<string[]> {
  const patterns: string[] = [];
  for (const lang of config.languages) {
    const g = GLOBS_BY_LANG[lang];
    if (g) patterns.push(...g);
  }
  const ignore = config.exclude.map((e) => `**/${e}/**`);
  const files = await fg(patterns, {
    cwd: root,
    ignore,
    absolute: true,
    dot: false,
    followSymbolicLinks: false,
  });
  return files;
}
