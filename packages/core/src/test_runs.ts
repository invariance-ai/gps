import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import path from "node:path";

const REL = ".gps/test_runs.jsonl";

export interface TestRun {
  at: string;
  command: string;
  exit: number;
  symbols: string[];
  failed_tests: string[];
  feature?: string;
  message?: string;
}

export async function recordTestRun(root: string, run: TestRun): Promise<void> {
  const p = path.join(root, REL);
  await mkdir(path.dirname(p), { recursive: true });
  await appendFile(p, JSON.stringify(run) + "\n");
}

export async function readTestRuns(root: string, limit = 100): Promise<TestRun[]> {
  try {
    const raw = await readFile(path.join(root, REL), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const tail = lines.slice(-limit);
    const out: TestRun[] = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as TestRun);
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Recent failed runs touching any of the given symbols. */
export async function recentFailuresForSymbols(
  root: string,
  symbols: string[],
  limit = 5,
): Promise<TestRun[]> {
  const all = await readTestRuns(root, 500);
  const set = new Set(symbols);
  const failures = all.filter((r) => r.exit !== 0 && r.symbols.some((s) => set.has(s)));
  return failures.slice(-limit).reverse();
}

/**
 * Extract failed test names from common runner output (vitest/jest/pytest).
 * Best-effort: returns an empty array if nothing matches.
 */
export function parseFailedTests(output: string): string[] {
  const failed = new Set<string>();
  // vitest/jest: lines like  "FAIL  src/foo.test.ts > suite > test name"
  for (const m of output.matchAll(/\bFAIL\b\s+([^\s]+)(?:\s+>\s+(.+))?/g)) {
    const file = m[1];
    const name = m[2];
    if (file) failed.add(name ? `${file} > ${name.trim()}` : file);
  }
  // pytest: lines like  "FAILED tests/test_foo.py::test_bar"
  for (const m of output.matchAll(/\bFAILED\s+([^\s]+::[^\s]+)/g)) {
    if (m[1]) failed.add(m[1]);
  }
  // jest summary: "  ✕ should do thing"
  for (const m of output.matchAll(/^\s+[×✕]\s+(.+)$/gm)) {
    if (m[1]) failed.add(m[1].trim());
  }
  return [...failed];
}

/**
 * Write a sidecar file in `.gps/sessions/last-prepared.txt`-style form so that
 * the test-run picks up the active symbol. We just read the existing one if
 * present.
 */
export async function readLastPreparedSymbol(root: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path.join(root, ".gps/sessions/last-prepared.txt"), "utf8");
    return raw.trim() || undefined;
  } catch {
    return undefined;
  }
}
