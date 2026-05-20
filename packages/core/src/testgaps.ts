import type { SymbolRef } from "@invariance/gps-schemas";
import type { QueryContext } from "./query.js";
import { calleesOf } from "./query.js";
import { testsForSymbol } from "./tests.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface TestGap {
  callee: string;
  file: string;
  reason: "no-test" | "not-co-tested";
}

/**
 * For each callee of `origin`, flag when no test file references both the
 * origin and the callee — i.e. the edge `origin → callee` is unprotected.
 */
export async function gapsForSymbol(
  ctx: QueryContext,
  origin: SymbolRef,
  cap = 5,
): Promise<TestGap[]> {
  const callees = calleesOf(origin, ctx).slice(0, cap * 4);
  if (callees.length === 0) return [];

  const originName = origin.name;
  const originTests = await testsForSymbol(originName, origin.file, ctx.root, ctx.index);
  const out: TestGap[] = [];

  for (const c of callees) {
    if (out.length >= cap) break;
    const calleeTests = await testsForSymbol(c.name, c.file, ctx.root, ctx.index);
    if (calleeTests.length === 0) {
      out.push({ callee: c.qualified_name ?? c.name, file: c.file, reason: "no-test" });
      continue;
    }
    let coTested = false;
    for (const t of originTests) {
      try {
        const src = await readFile(path.join(ctx.root, t.file), "utf8");
        if (src.includes(c.name)) {
          coTested = true;
          break;
        }
      } catch {
        /* ignore */
      }
    }
    if (!coTested) {
      out.push({ callee: c.qualified_name ?? c.name, file: c.file, reason: "not-co-tested" });
    }
  }
  return out;
}
