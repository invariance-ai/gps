import fg from "fast-glob";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
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
    return {
      languages: data.languages ?? (["typescript", "python", "go", "rust", "java", "ruby", "csharp"] as GpsLanguage[]),
      exclude: [...DEFAULT_EXCLUDE, ...(data.exclude ?? [])],
      depth: data.depth ?? 3,
      strands: data.strands ?? ["structural", "tests", "provenance", "invariants"],
    };
  } catch {
    return {
      languages: ["typescript", "python", "go", "rust", "java", "ruby", "csharp"],
      exclude: DEFAULT_EXCLUDE,
      depth: 3,
      strands: ["structural", "tests", "provenance", "invariants"],
    };
  }
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
