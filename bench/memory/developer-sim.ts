/**
 * The simulated human ("developer-sim"). It issues a correction the way a real dev would
 * — using a PARAPHRASE of the rule, never the canonical string — so the benchmark measures
 * capture + recall, not string matching.
 */
import type { Rule } from "./types.js";

/** Deterministic-by-seed choice of a paraphrase (so trials are reproducible). */
export function pickParaphrase(rule: Rule, seed = Math.random()): string {
  if (rule.paraphrases.length === 0) {
    throw new Error(`rule ${rule.id} has no paraphrases to teach with`);
  }
  const i = Math.floor(seed * rule.paraphrases.length);
  const clamped = Math.max(0, Math.min(i, rule.paraphrases.length - 1));
  return rule.paraphrases[clamped]!;
}

/**
 * The TEACH-turn message: the human's natural correction. Light framing only — the
 * paraphrase carries the intent. Crucially this never contains `rule.canonical`.
 */
export function teachPrompt(rule: Rule, paraphrase: string): string {
  const anchor = rule.symbol ? ` (re: \`${rule.symbol}\`)` : "";
  return `${paraphrase}${anchor}`;
}

/**
 * The TEST-turn message for a fresh session. Puts the rule in tension WITHOUT restating it.
 * For the in-context (ceiling) arm we prepend the canonical rule; every other arm gets the
 * bare task and must rely on memory (or fail).
 */
export function testPrompt(rule: Rule, injectRule: boolean): string {
  if (injectRule) {
    return `Note: ${rule.canonical}\n\n${rule.test_task}`;
  }
  return rule.test_task;
}
