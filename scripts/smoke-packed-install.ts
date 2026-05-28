#!/usr/bin/env tsx
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

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
    env: { ...process.env, CI: "1" },
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function main(): Promise<void> {
  const work = await mkdtemp(path.join(tmpdir(), "gps-pack-smoke-"));
  const packDir = path.join(work, "packs");
  const installDir = path.join(work, "install");
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

  await run("git", ["init", "-q", installDir], work);
  await writeFile(path.join(installDir, "hello.ts"), "export function hello() { return 'hi'; }\n");
  await writeFile(
    path.join(installDir, ".gitignore"),
    [".gps/index/", ".gps/observations.json", ""].join("\n"),
  );

  const gps = path.join(work, "node_modules/.bin/gps");
  await run(gps, ["--help"], installDir);
  await run(gps, ["setup", "--yes", "--with-codex"], installDir);
  await run(gps, ["doctor", "--json"], installDir);

  console.log(`packed install smoke passed (${tarballs.length} tarballs)`);
}

main().catch((err: Error) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
