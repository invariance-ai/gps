#!/usr/bin/env tsx
// Cut a coordinated release of all gps packages.
//
//   pnpm tsx scripts/release.ts <version>           # bump + commit + tag
//   pnpm tsx scripts/release.ts <version> --publish # bump + build + publish + commit + tag
//   pnpm tsx scripts/release.ts --check             # verify all packages are at the same version
//
// pnpm rewrites `workspace:*` into the actual version when publishing, so we
// only need to bump every package's own `version` field in lockstep.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

const PACKAGES = [
  "packages/schemas",
  "packages/core",
  "packages/llm",
  "packages/mcp",
  "packages/cli",
];

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

async function readPkg(dir: string): Promise<{ path: string; data: any }> {
  const p = path.join(ROOT, dir, "package.json");
  return { path: p, data: JSON.parse(await readFile(p, "utf8")) };
}

function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v);
}

function run(cmd: string): void {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit" });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const doPublish = args.includes("--publish");
  const version = args.find((a) => !a.startsWith("--"));

  const pkgs = await Promise.all(PACKAGES.map(readPkg));

  if (check) {
    const versions = new Set(pkgs.map((p) => p.data.version));
    if (versions.size !== 1) {
      console.error("Version drift across packages:");
      for (const p of pkgs) console.error(`  ${p.data.name} ${p.data.version}`);
      process.exit(1);
    }
    console.log(`All ${pkgs.length} packages at ${[...versions][0]}`);
    return;
  }

  if (!version) {
    console.error("usage: release <version> [--publish]");
    console.error("       release --check");
    process.exit(1);
  }
  if (!isSemver(version)) {
    console.error(`Not a semver: ${version}`);
    process.exit(1);
  }

  // Refuse if working tree is dirty.
  const status = execSync("git status --porcelain", { cwd: ROOT }).toString().trim();
  if (status) {
    console.error("Working tree is dirty. Commit or stash before releasing.");
    process.exit(1);
  }

  // Refuse if not on main — tags otherwise land on a feature/worktree branch
  // and a follow-up `git push --tags` decorates the wrong commit.
  const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: ROOT }).toString().trim();
  if (branch !== "main" && !process.env.RELEASE_ALLOW_BRANCH) {
    console.error(`Refusing to release from branch '${branch}'. Switch to main, or set RELEASE_ALLOW_BRANCH=1.`);
    process.exit(1);
  }

  for (const { path: p, data } of pkgs) {
    data.version = version;
    await writeFile(p, JSON.stringify(data, null, 2) + "\n");
    console.log(`  ${data.name} → ${version}`);
  }

  run("pnpm build");

  if (doPublish) {
    // pnpm publishes in topological order and rewrites workspace:* to the
    // concrete version at publish time. --access public for scoped packages.
    run("pnpm -r publish --access public --no-git-checks");
  }

  run(`git add ${PACKAGES.map((d) => `${d}/package.json`).join(" ")}`);
  run(`git commit -m "chore: release v${version}"`);
  run(`git tag v${version}`);

  console.log("");
  console.log(`Released v${version}. Push with:`);
  console.log(`  git push && git push --tags`);
  if (!doPublish) {
    console.log(`To publish to npm, re-run with --publish, or:`);
    console.log(`  pnpm -r publish --access public`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
