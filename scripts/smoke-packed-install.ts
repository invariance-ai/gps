#!/usr/bin/env tsx
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NPM_CACHE = path.join(tmpdir(), "gps-pack-smoke-npm-cache");

const PACKAGES = [
  "packages/schemas",
  "packages/core",
  "packages/llm",
  "packages/mcp",
  "packages/cli",
];

async function run(cmd: string, args: string[], cwd: string): Promise<void> {
  await execFile(cmd, args, {
    cwd,
    env: { ...process.env, CI: "1", npm_config_cache: NPM_CACHE },
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

async function assertFile(root: string, rel: string): Promise<void> {
  if (!(await exists(path.join(root, rel)))) {
    throw new Error(`expected ${rel} to exist`);
  }
}

async function assertNoFile(root: string, rel: string): Promise<void> {
  if (await exists(path.join(root, rel))) {
    throw new Error(`expected ${rel} not to exist`);
  }
}

async function makeRepo(parent: string, name: string): Promise<string> {
  const dir = path.join(parent, name);
  await mkdir(dir, { recursive: true });
  await run("git", ["init", "-q"], dir);
  await writeFile(path.join(dir, "hello.ts"), "export function hello() { return 'hi'; }\n");
  await writeFile(
    path.join(dir, ".gitignore"),
    [".gps/index/", ".gps/observations.json", ""].join("\n"),
  );
  return dir;
}

async function assertDoctorOk(gps: string, repo: string): Promise<void> {
  await run(gps, ["doctor", "--json"], repo);
}

async function main(): Promise<void> {
  const work = await mkdtemp(path.join(tmpdir(), "gps-pack-smoke-"));
  const packDir = path.join(work, "packs");
  await mkdir(packDir, { recursive: true });

  for (const pkg of PACKAGES) {
    await run("pnpm", ["pack", "--pack-destination", packDir], path.join(ROOT, pkg));
  }

  const tarballs = (await readdir(packDir))
    .filter((f) => f.endsWith(".tgz"))
    .map((f) => path.join(packDir, f))
    .sort();

  await run("npm", ["init", "-y"], work);
  await run("npm", ["install", "--no-audit", "--no-fund", ...tarballs], work);

  const gps = path.join(work, "node_modules/.bin/gps");
  await run(gps, ["--help"], work);

  const codexRepo = await makeRepo(work, "install-codex");
  await run(gps, ["setup", "--yes", "--with-codex"], codexRepo);
  await assertFile(codexRepo, "AGENTS.md");
  await assertFile(codexRepo, ".codex/config.toml");
  await assertNoFile(codexRepo, "CLAUDE.md");
  await assertNoFile(codexRepo, ".claude/settings.json");
  await assertNoFile(codexRepo, ".cursor/rules/gps.mdc");
  await assertDoctorOk(gps, codexRepo);

  const claudeRepo = await makeRepo(work, "install-claude");
  await run(gps, ["setup", "--yes", "--with-claude"], claudeRepo);
  await assertFile(claudeRepo, "CLAUDE.md");
  await assertFile(claudeRepo, ".claude/skills/gps/SKILL.md");
  await assertFile(claudeRepo, ".claude/settings.json");
  await assertFile(claudeRepo, ".mcp.json");
  await assertNoFile(claudeRepo, "AGENTS.md");
  await assertNoFile(claudeRepo, ".codex/config.toml");
  await assertNoFile(claudeRepo, ".cursor/rules/gps.mdc");
  await assertDoctorOk(gps, claudeRepo);

  const cursorRepo = await makeRepo(work, "install-cursor");
  await run(gps, ["setup", "--yes", "--with-cursor"], cursorRepo);
  await assertFile(cursorRepo, ".cursor/rules/gps.mdc");
  await assertFile(cursorRepo, ".cursor/mcp.json");
  await assertNoFile(cursorRepo, "CLAUDE.md");
  await assertNoFile(cursorRepo, "AGENTS.md");
  await assertNoFile(cursorRepo, ".codex/config.toml");
  await assertDoctorOk(gps, cursorRepo);

  const allRepo = await makeRepo(work, "install-all");
  await run(gps, ["setup", "--yes", "--with-claude", "--with-codex", "--with-cursor"], allRepo);
  await assertFile(allRepo, "CLAUDE.md");
  await assertFile(allRepo, ".claude/settings.json");
  await assertFile(allRepo, ".mcp.json");
  await assertFile(allRepo, "AGENTS.md");
  await assertFile(allRepo, ".codex/config.toml");
  await assertFile(allRepo, ".cursor/rules/gps.mdc");
  await assertFile(allRepo, ".cursor/mcp.json");
  await assertDoctorOk(gps, allRepo);

  console.log(`packed install smoke passed (${tarballs.length} tarballs)`);
}

main().catch((err: Error) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
