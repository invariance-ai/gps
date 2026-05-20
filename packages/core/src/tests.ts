import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TestRef } from "@invariance/gps-schemas";
import type { GpsIndex } from "./index_store.js";

/**
 * Test discovery heuristics (v0.1):
 *   - co-located: foo.ts ↔ foo.test.ts / foo.spec.ts / test_foo.py / foo_test.py
 *   - mention-based: any test file that mentions the symbol name verbatim
 *
 * Trade-off: false positives on common names (e.g. "init"). The CLI dedupes
 * and ranks co-located matches higher.
 */
export function testFilesIn(index: GpsIndex): string[] {
  const set = new Set<string>();
  for (const file of index.files ?? []) {
    if (isTestFile(file)) set.add(file);
  }
  for (const s of index.symbols) {
    if (isTestFile(s.file)) set.add(s.file);
  }
  return [...set];
}

export function isTestFile(file: string): boolean {
  const base = path.basename(file);
  return (
    /\.(test|spec)\.[jt]sx?$/.test(base) ||
    /^test_.+\.py$/.test(base) ||
    /.+_test\.py$/.test(base)
  );
}

export function frameworkFor(file: string): TestRef["framework"] {
  const base = path.basename(file);
  if (base.endsWith(".py")) return "pytest";
  if (/\.spec\./.test(base)) return "vitest";
  if (/\.test\./.test(base)) return "jest";
  return "unknown";
}

const testFileCache = new Map<string, string>();

export function clearTestFileCache(): void {
  testFileCache.clear();
}

async function readTestFile(root: string, rel: string): Promise<string> {
  const key = `${root}::${rel}`;
  const cached = testFileCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const src = await readFile(path.join(root, rel), "utf8");
    testFileCache.set(key, src);
    return src;
  } catch {
    testFileCache.set(key, "");
    return "";
  }
}

export async function testsForSymbol(
  symbol: string,
  symbolFile: string,
  root: string,
  index: GpsIndex,
): Promise<TestRef[]> {
  const out: TestRef[] = [];
  const candidates = testFilesIn(index);

  const dir = path.dirname(symbolFile);
  const stem = path.basename(symbolFile).replace(/\.[jt]sx?$|\.py$/, "");
  const coLocated = new Set([
    path.join(dir, `${stem}.test.ts`),
    path.join(dir, `${stem}.test.tsx`),
    path.join(dir, `${stem}.test.js`),
    path.join(dir, `${stem}.spec.ts`),
    path.join(dir, `${stem}.spec.js`),
    path.join(dir, `test_${stem}.py`),
    path.join(dir, `${stem}_test.py`),
  ]);

  for (const t of candidates) {
    const isColo = coLocated.has(t);
    const src = await readTestFile(root, t);
    const covers = src.length > 0 && src.includes(symbol);
    if (covers || isColo) {
      out.push({
        file: t,
        framework: frameworkFor(t),
        symbols_covered: [symbol],
      });
    }
  }

  // co-located first
  out.sort((a, b) => {
    const ac = coLocated.has(a.file) ? 0 : 1;
    const bc = coLocated.has(b.file) ? 0 : 1;
    return ac - bc;
  });
  return out;
}
