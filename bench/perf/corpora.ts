import { mkdir, stat } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

export interface Corpus {
  name: string;
  repo: string;
  ref: string;
  shallow?: boolean;
}

export const CORPORA: Record<string, Corpus> = {
  flask: {
    name: "flask",
    repo: "https://github.com/pallets/flask.git",
    ref: "3.0.3",
    shallow: true,
  },
  django: {
    name: "django",
    repo: "https://github.com/django/django.git",
    ref: "5.0.6",
    shallow: true,
  },
  linux: {
    name: "linux",
    repo: "https://github.com/torvalds/linux.git",
    ref: "v6.10",
    shallow: true,
  },
};

export function cacheDir(): string {
  return path.join(os.homedir(), ".cache", "gps-bench", "corpora");
}

export async function ensureCorpus(c: Corpus): Promise<string> {
  const root = path.join(cacheDir(), c.name);
  await mkdir(cacheDir(), { recursive: true });
  let exists = false;
  try {
    await stat(path.join(root, ".git"));
    exists = true;
  } catch {}
  if (!exists) {
    const depth = c.shallow ? "--depth=1" : "";
    const branch = c.ref ? `--branch=${c.ref}` : "";
    execSync(`git clone ${depth} ${branch} ${c.repo} ${root}`, { stdio: "inherit" });
  }
  return root;
}
